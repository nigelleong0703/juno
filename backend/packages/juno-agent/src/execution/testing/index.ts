/**
 * Testkit: deterministic test doubles. Never imported by production packages; the runner loads the
 * file-driven scripted model only when MODEL_PROVIDER=scripted.
 */

import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import type { AssistantTurn } from '../../contracts/index.js';
import type { ModelProvider } from '../brain/index.js';
import { assistantMessage } from '../brain/messages.js';
import { unwrapProxyCalls } from '../brain/tool-proxy.js';
import type { Message } from '@earendil-works/pi-ai';

export interface ScriptedTurn {
  /** Match on the last user message text (optional) */
  matchLastText?: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  /**
   * With `matchLastText`: play this turn only as the model's call number `step` (0 = first) since the last user
   * message, however many earlier turns the context still holds (after a compaction the index into the script
   * cannot be known). A turn without `step` keeps the by-position behavior.
   */
  step?: number;
}

interface Cursor {
  index: number;
  matched: Set<number>;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

function textTurn(text: string): AssistantTurn {
  return { text, toolCalls: [], usage: ZERO_USAGE, stopReason: 'stop' };
}

function toAssistantTurn(turn: ScriptedTurn): AssistantTurn {
  const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
  return {
    text: turn.text ?? '',
    toolCalls,
    usage: turn.usage ?? ZERO_USAGE,
    stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

function imageHashes(messages: Message[]): string[] {
  return messages.flatMap((message) => (message.role === 'assistant' || typeof message.content === 'string' ? [] : message.content))
    .flatMap((part) => (part.type === 'image' ? [createHash('sha256').update(Buffer.from(part.data, 'base64')).digest('hex')] : []));
}

function lastUserText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    for (const part of msg.content) {
      if (part.type === 'text') return part.text;
    }
  }
  return null;
}

/** How many model turns this session has already durably recorded (the harness appends one per call). */
function assistantTurns(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant') count += 1;
  }
  return count;
}

/** The text of the user messages this run was started with: the last user message and the user messages right before it (a context note may follow the wake text). */
function runUserText(messages: Message[]): string {
  let end = messages.length - 1;
  while (end >= 0 && messages[end]?.role !== 'user') end -= 1;
  const parts: string[] = [];
  for (let i = end; i >= 0 && messages[i]?.role === 'user'; i--) {
    const content = messages[i]?.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) for (const part of content) if (part.type === 'text') parts.push(part.text);
  }
  // Context notes the harness appends (date, profile update, ...) are not what the user said.
  return parts.filter((part) => !part.startsWith('<context_update>')).join('\n');
}

/** How many assistant turns follow the last user message: the call number within the current run. */
function stepsSinceUser(messages: Message[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role !== 'user'; i--) {
    if (messages[i]?.role === 'assistant') count += 1;
  }
  return count;
}

/** Select a turn by its position in the script, honouring an optional `matchLastText` branch. */
function turnFromScript(script: ScriptedTurn[], index: number, messages: Message[]): AssistantTurn {
  const turn = script[index];
  if (!turn) return textTurn('No more scripted responses');

  const userText = lastUserText(messages);
  if (turn.matchLastText && userText && !userText.includes(turn.matchLastText)) {
    for (let i = index + 1; i < script.length; i++) {
      const candidate = script[i];
      if (candidate?.matchLastText && userText.includes(candidate.matchLastText)) return toAssistantTurn(candidate);
    }
  }
  return toAssistantTurn(turn);
}

/**
 * Pick the next turn. Turns play in order; a turn with matchLastText instead searches forward for an
 * unused turn whose matchLastText occurs in the last user message, and does not advance the cursor.
 */
function nextTurn(script: ScriptedTurn[], cursor: Cursor, messages: Message[]): AssistantTurn {
  let selected = cursor.index;
  const current = script[selected];
  if (!current) return textTurn('No more scripted responses');

  const userText = lastUserText(messages);
  if (current.matchLastText && userText) {
    for (let i = cursor.index; i < script.length; i++) {
      const needle = script[i]?.matchLastText;
      if (needle && userText.includes(needle) && !cursor.matched.has(i)) {
        selected = i;
        cursor.matched.add(i);
        break;
      }
    }
  }
  if (!current.matchLastText) cursor.index += 1;

  return toAssistantTurn(script[selected] ?? current);
}

/** Scripted deterministic model over a fixed script, advancing on every call. */
export function createScriptedModel(script: ScriptedTurn[]): ModelProvider {
  const cursor: Cursor = { index: 0, matched: new Set() };
  return {
    async call({ messages, onDelta }) {
      const turn = nextTurn(script, cursor, messages);
      if (onDelta && turn.text) onDelta(turn.text);
      return turn;
    },
  };
}

/** How the file-driven scripted model streams its text: this many characters, then a short pause. */
const SCRIPT_CHUNK_CHARS = 16;
const SCRIPT_CHUNK_MS = 8;

/**
 * Scripted model that re-reads `{ [sessionKey]: ScriptedTurn[] }` from a JSON file on every call.
 * The turn index is derived from the durable transcript (assistant turns the harness already
 * recorded), never from process memory, so a killed-and-restarted runner resumes the same sequence
 * instead of replaying from turn 0.
 */
export function createDynamicScriptedModel(scriptFilePath: string, limits?: { contextWindow?: number }): ModelProvider {
  return {
    ...(limits === undefined ? {} : { getLimits: async () => limits }),
    async call({ messages, tools, onDelta, sessionKey = 'default' }) {
      // Auxiliary one-shots (run titles, role suggestions) get an empty reply, so they never consume a script turn.
      if (sessionKey.startsWith('aux:')) return textTurn('');
      // What the model was offered on this call, beside the script file: a scenario asserts the visible tool list and
      // the images the request carried (sha256 of their bytes, so a scenario can tell the bytes really arrived).
      // Hidden tools (deferLoading) are not offered on a proxy-mode wire, so they are not listed.
      await appendFile(scriptFilePath + '.tools.jsonl', JSON.stringify({ sessionKey, tools: tools.filter((tool) => tool.deferLoading !== true).map((tool) => tool.name), images: imageHashes(messages) }) + '\n');
      let scripts: Record<string, ScriptedTurn[]>;
      try {
        scripts = JSON.parse(await readFile(scriptFilePath, 'utf-8'));
      } catch {
        return textTurn('Script file not found or invalid JSON');
      }
      // A child run's key embeds its runtime id (`agent:conv::child:<runId>`); tests script every child of a
      // chat through the wildcard `agent:conv::child:*`.
      const childWildcard = sessionKey.includes('::child:') ? sessionKey.slice(0, sessionKey.indexOf('::child:')) + '::child:*' : undefined;
      const script = scripts[sessionKey] ?? (childWildcard === undefined ? undefined : scripts[childWildcard]) ?? [{ text: 'I am operating with the scripted model for testing.' }];
      const startedWith = runUserText(messages);
      const steps = stepsSinceUser(messages);
      const stepped = script.find((candidate) => candidate.step === steps && candidate.matchLastText !== undefined && startedWith.includes(candidate.matchLastText));
      const scripted = stepped === undefined ? turnFromScript(script, assistantTurns(messages), messages) : toAssistantTurn(stepped);
      // Streams like a real model, in small chunks with small gaps, so a scenario can see the run still writing.
      if (onDelta && scripted.text) {
        for (let at = 0; at < scripted.text.length; at += SCRIPT_CHUNK_CHARS) {
          if (at > 0) await new Promise<void>((resolve) => { setTimeout(resolve, SCRIPT_CHUNK_MS); });
          onDelta(scripted.text.slice(at, at + SCRIPT_CHUNK_CHARS));
        }
      }
      // As the real provider does: the stored message keeps the script's `tool_call` blocks, the reply names the tool each reaches.
      return { ...scripted, message: assistantMessage(scripted), toolCalls: unwrapProxyCalls(scripted.toolCalls) };
    },
  };
}
