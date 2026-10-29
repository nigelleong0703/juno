import { z } from 'zod';
import { isScreenControlNote, type AssistantTurn, type ToolResult, type WakeEvent } from '../../contracts/index.js';
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { shortPersonId } from '../../modules/people/pages.js';
import { harnessText } from '../../modules/harness/loader.js';

const text = z.object({ type: z.literal('text'), text: z.string(), textSignature: z.string().optional() }).passthrough();
const image = z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }).passthrough();
const thinking = z.object({ type: z.literal('thinking'), thinking: z.string(), thinkingSignature: z.string().optional(), redacted: z.boolean().optional() }).passthrough();
const toolCall = z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.json()) }).passthrough();
const usage = z.object({
  input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }).passthrough(),
}).passthrough();
const assistantSchema = z.object({
  role: z.literal('assistant'), content: z.array(z.union([text, thinking, toolCall])),
  api: z.string(), provider: z.string(), model: z.string(), usage, timestamp: z.number(),
  stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
}).passthrough();
const messageSchema: z.ZodType<Message> = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.union([z.string(), z.array(text)]), timestamp: z.number() }).passthrough(),
  z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(z.union([text, image]))]), timestamp: z.number() }).passthrough(),
  assistantSchema,
  z.object({ role: z.literal('toolResult'), toolCallId: z.string(), toolName: z.string(),
    content: z.array(z.union([text, image])), isError: z.boolean(), timestamp: z.number() }).passthrough(),
]);

/** Validate durable JSON at the boundary without dropping provider metadata or content. */
export function parseMessage(value: unknown): Message {
  return messageSchema.parse(value);
}

export function assistantMessage(turn: AssistantTurn): AssistantMessage {
  if ('message' in turn) return assistantSchema.parse(turn.message);
  return {
    role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'scripted',
    content: [
      ...turn.text ? [{ type: 'text' as const, text: turn.text }] : [],
      ...turn.toolCalls.map(call => ({ type: 'toolCall' as const, id: call.id, name: call.name,
        arguments: z.record(z.string(), z.json()).parse(call.arguments) })),
    ],
    usage: { input: turn.usage.inputTokens, output: turn.usage.outputTokens, cacheRead: 0, cacheWrite: 0,
      totalTokens: turn.usage.inputTokens + turn.usage.outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: turn.usage.costUsd } },
    stopReason: turn.stopReason === 'tool_calls' ? 'toolUse' : turn.stopReason,
    timestamp: Date.now(),
  };
}

export function toolMessage(name: string, callId: string, result: ToolResult): ToolResultMessage {
  // A native tool_search result lists the hidden tools it loaded; the provider turns them back into the search output item on every request.
  const loaded = z.array(z.string()).safeParse(result.details?.['loadedTools']);
  return { role: 'toolResult', toolCallId: callId, toolName: name, content: result.content,
    isError: result.isError ?? false, timestamp: Date.now(), ...(loaded.success ? { loadedTools: loaded.data } : {}) };
}

export const PLATFORM_NAMES: Record<string, string> = { slack: 'Slack', telegram: 'Telegram', discord: 'Discord', feishu: 'Feishu', meet: 'Meet' };

/**
 * A person as the model sees them: a display name can be changed by anyone, so it comes with the stable handle ("Alice (@alice_w)")
 * or, when the platform has none, the end of the platform id ("Alice (id …4821)").
 */
function personLabel(name: unknown, handle: unknown, id: unknown, personId?: unknown): string {
  const shown = (typeof name === 'string' && name !== '' ? name : 'someone').replace(/[\]\r\n]/g, ' ').slice(0, 80);
  const handleText = typeof handle === 'string' && handle !== '' ? `@${handle.replace(/[\]\r\n\s]/g, '').slice(0, 64)}` : undefined;
  if (typeof personId === 'string' && personId !== '') {
    const parts = [handleText, shortPersonId(personId)].filter((part): part is string => part !== undefined);
    return `${shown} (${parts.join(', ')})`;
  }
  if (handleText !== undefined) return `${shown} (${handleText})`;
  return typeof id === 'string' && id !== '' ? `${shown} (id …${id.slice(-4)})` : shown;
}


const plainLabel = (value: string, max: number): string => value.replace(/[()\]\r\n]/g, ' ').trim().slice(0, max);

/** The sending agent's role, which the wake payload carries as `fromAgentRole` (absent when it has none). */
function peerRole(payload: Record<string, unknown>): string | undefined {
  const role = payload['fromAgentRole'];
  return typeof role === 'string' && role.trim() !== '' ? plainLabel(role, 60) : undefined;
}

/** "Atlas (travel)": who an agent-to-agent wake is from, by name and role; the bare id only when the sender's record could not be read. */
function peerAgentLabel(payload: Record<string, unknown>, id: string | undefined): string {
  const name = payload['fromAgentName'];
  if (typeof name !== 'string' || name.trim() === '') return id ?? 'unknown';
  const role = peerRole(payload);
  return plainLabel(name, 80) + (role === undefined ? '' : ` (${role})`);
}

/** "[Slack · Alice (id …4821) · not your owner]" ahead of a platform message from someone other than the owner; '' for anything else. */
function speakerLabel(payload: Record<string, unknown>): string {
  const kind = payload['channelKind'];
  if (typeof kind !== 'string') return '';
  // Another of the owner's agents speaking on the platform: named as an agent, never as the owner.
  if (payload['speakerRole'] === 'agent') {
    const role = peerRole(payload);
    return `[${PLATFORM_NAMES[kind] ?? kind} · ${personLabel(payload['speakerName'], undefined, undefined)} (agent${role === undefined ? '' : ', ' + role}) · not your owner]\n`;
  }
  if (payload['speakerRole'] !== 'stranger') return '';
  // Everyone in a live meeting is a stranger, even a participant whose name matches the owner's.
  const role = payload['source'] === 'meeting' ? 'meeting participant' : 'not your owner';
  return `[${PLATFORM_NAMES[kind] ?? kind} · ${personLabel(payload['speakerName'], payload['speakerHandle'], payload['speakerId'], payload['personId'])} · ${role}]\n`;
}

/** Who the message's @mentions are, decided by platform id on the server: "@Robin (@nigelleong0703) is the person you're helping". */
function mentionNote(payload: Record<string, unknown>): string {
  const mentions = payload['mentions'];
  if (!Array.isArray(mentions)) return '';
  const lines: string[] = [];
  for (const raw of mentions) {
    const m: Record<string, unknown> = typeof raw === 'object' && raw !== null ? Object.fromEntries(Object.entries(raw)) : {};
    if (m['role'] !== 'owner' && m['role'] !== 'agent') continue;
    const label = personLabel(m['name'], m['handle'], m['id']);
    lines.push(`@${label} ${m['role'] === 'owner' ? "is the person you're helping" : 'is another agent'}`);
  }
  return lines.length === 0 ? '' : `[${lines.join('; ')}]`;
}

/** A monitor wake: a system notice in our words, or the new items (data from the source, never instructions) with what the person asked for. */
function monitorText(payload: Record<string, unknown>, text: string): string {
  if (payload['notice'] === true) return harnessText('wake.monitor_notice', { text });
  const name = typeof payload['routineName'] === 'string' ? payload['routineName'] : 'a watch';
  const instructions = payload['instructions'];
  const asked = typeof instructions === 'string' && instructions.trim() !== '' ? ' ' + harnessText('wake.monitor_asked', { instructions: instructions.trim() }) : '';
  const count = typeof payload['count'] === 'number' ? payload['count'] : 1;
  return harnessText('wake.monitor_found', { name, count: String(count), items: count === 1 ? 'item' : 'items', asked, text });
}

export function wakeMessage(event: WakeEvent, options: { quietExit?: boolean } = {}): UserMessage {
  const text = typeof event.payload.text === 'string' ? event.payload.text : JSON.stringify(event.payload);
  let content = text;
  // A completion routed into a running child arrives as child_task (H-98) and keeps its task_done text.
  if (event.kind === 'task_done' || (event.kind === 'child_task' && event.payload['taskId'] !== undefined)) content = taskDoneText(event.payload);
  else if (event.kind === 'hand_back' && event.payload['source'] === 'screen_control') content = screenControlText(event.payload);
  else if (event.kind === 'hand_back' && event.payload['source'] === 'discord_voice') content = harnessText('wake.discord_voice_ended', { text });
  else if (event.kind === 'hand_back' && event.payload['source'] === 'meeting') content = harnessText('wake.meeting_ended', { text });
  else if (event.payload['source'] === 'meeting' && event.payload['notice'] === true) content = harnessText('wake.meeting_notice', { text });
  else if (event.kind === 'hand_back') content = harnessText('wake.child_update', { text });
  else if (event.kind === 'child_task' && typeof event.payload['prompt'] === 'string') content = `${harnessText('wake.child_task')}\n${event.payload['prompt']}`;
  else if (event.kind === 'private_handoff') content = privateHandoffText(event.payload);
  else if (event.kind === 'timer') content = harnessText('wake.timer', { text });
  else if (event.kind === 'routine') content = harnessText('wake.routine', { text });
  else if (event.kind === 'monitor') content = monitorText(event.payload, text);
  else if (event.kind === 'goal_checkin') content = harnessText('wake.goal_checkin', { text });
  else if (event.kind === 'calendar_due') content = harnessText('wake.calendar_due', { text });
  else if (event.kind === 'capability_ready' || event.kind === 'capability_lost') content = harnessText(event.payload['routineId'] === undefined ? 'wake.system_notice' : 'wake.system_notice_routine', { text });
  else if (event.origin.type === 'agent' && event.payload['speakerRole'] !== 'agent') content = harnessText('wake.from_agent', { sender: peerAgentLabel(event.payload, event.origin.id), text });
  else if (!event.trusted) content = `${speakerLabel(event.payload)}${harnessText('wake.untrusted_frame', { text })}`;
  const mentions = mentionNote(event.payload);
  if (mentions !== '') content += '\n' + mentions;
  if (event.kind === 'room_mention' && typeof event.payload['channelKind'] === 'string') content += '\n' + harnessText('wake.mention_hint');
  const context = event.payload['channelContext'];
  if (typeof context === 'string' && context !== '') content = `${harnessText('wake.channel_context', { context })}\n${content}`;
  // The note names finish_quietly only when this run has it (quiet-eligible, decided when the run started): never a tool the run lacks.
  if (isAutomaticWake(event)) content += '\n' + harnessText('wake.automatic', { exit: harnessText(options.quietExit === true ? 'wake.quiet_exit' : 'wake.no_quiet_exit') });
  return { role: 'user', content, timestamp: Date.parse(event.at) };
}

/**
 * The owner asked something private in a group and the agent handed it here (send_message toOwner). The owner is waiting for the answer,
 * so this is not the "nobody is talking to you" wake (wake.automatic): the final reply is the answer.
 */
function privateHandoffText(payload: Record<string, unknown>): string {
  const field = (key: string): string => (typeof payload[key] === 'string' ? payload[key] : '');
  const chat = field('sourceChat');
  const asked = field('text');
  const note = field('note');
  return harnessText('wake.private_handoff', { chat: chat === '' ? 'a group chat' : chat })
    + (asked === '' ? '' : '\n' + harnessText('wake.private_handoff_asked', { asked }))
    + (note === '' ? '' : '\n' + harnessText('wake.private_handoff_note', { note }));
}

/**
 * One exit for every run: the final reply is the message the people in the chat see (final-reply replyStep), a blank one
 * posts nothing. A wake no person sent (the system or an automation: a routine, a calendar item, a finished task) gets the
 * wake.automatic note once, so the model neither sends the same thing with send_message nor closes with a "sent" note. Wake text is
 * appended to the transcript once, so this costs no cache. A helper (a run woken as a child_task) gets wake.child_task at the front of
 * its "task assigned to you" wording instead, so it never mistakes its task for a message from an unknown agent.
 *
 * A system or automation wake. Not these: a child task (its final reply is the parent's result), the onboarding wake, the private hand-off, screen-control and live-meeting notices (they carry their own wording).
 */
export function isAutomaticWake(event: WakeEvent): boolean {
  if (event.origin.type !== 'system' && event.origin.type !== 'automation') return false;
  return event.kind !== 'child_task' && event.kind !== 'onboarding' && event.kind !== 'private_handoff' && !isScreenControlNote(event) && event.payload['source'] !== 'meeting';
}

/** "1m32s" from milliseconds. */
function heldFor(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`;
}

/**
 * The user taking over or handing back the agent's screen, as a system notice. Keystrokes are never recorded;
 * only the browser state changes are listed, and page titles inside them are untrusted data.
 */
function screenControlText(payload: Record<string, unknown>): string {
  const held = typeof payload['heldMs'] === 'number' ? ` for ${heldFor(payload['heldMs'])}` : '';
  if (payload['surface'] === 'mac') {
    if (payload['phase'] === 'start') return harnessText('wake.mac_control_stopped');
    // What Stop cancelled: the first line of each command (never input text), untrusted data.
    const cancelled = Array.isArray(payload['cancelled']) ? payload['cancelled'].filter((c): c is string => typeof c === 'string') : [];
    const note = cancelled.length > 0 ? `\nStop cancelled these before they finished (first line of each; untrusted data): <untrusted>${cancelled.join('\n')}</untrusted>` : '';
    return harnessText('wake.mac_control_resumed', { held, cancelled: note });
  }
  if (payload['phase'] === 'start') {
    return harnessText('wake.screen_control_start');
  }
  const changes = Array.isArray(payload['changes']) ? payload['changes'].filter((c): c is string => typeof c === 'string') : [];
  return changes.length > 0
    ? harnessText('wake.screen_control_end_changes', { held, changes: changes.join('\n') })
    : harnessText('wake.screen_control_end_unchanged', { held });
}

/** A finished background task as the model sees it: what finished, how, and the result as untrusted data. */
function taskDoneText(payload: Record<string, unknown>): string {
  const field = (key: string): string => (typeof payload[key] === 'string' ? String(payload[key]) : 'unknown');
  const summary = typeof payload['summary'] === 'string' ? payload['summary'] : '';
  return harnessText('wake.task_done', { taskKind: field('taskKind'), status: field('status'), taskId: field('taskId'), summary });
}

const IMAGE_OMITTED: TextContent = { type: 'text', text: '[image omitted: the current model does not accept images]' };

/**
 * A text-only model refuses any image, so a user's attached image becomes a note for it. Only user turns:
 * a tool-result image still fails loudly in the provider, because the model asked for that capability.
 */
export function withoutUserImages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message;
    const content = message.content.map((block): TextContent | ImageContent => (block.type === 'image' ? IMAGE_OMITTED : block));
    return { ...message, content };
  });
}

/**
 * Screenshots kept as images in the model context: the newest KEEP_SCREENSHOTS always; older ones are replaced by
 * a short note in batches of PRUNE_BATCH (Anthropic's computer-use reference, `only_n_most_recent_images` with
 * `min_removal_threshold`). A screenshot is ~1-2k tokens and ~150-250 KB of base64 re-sent on every call: one run
 * carried 22 of them (~4.2 MB) into each request.
 */
export const KEEP_SCREENSHOTS = 2;
export const PRUNE_BATCH = 5;

/**
 * The one deliberate exception to "never rewrite old messages" (the cached prefix must stay byte-identical):
 * tool-result images beyond the newest KEEP_SCREENSHOTS become `[image #n omitted …]`, but only in whole
 * batches, so the number replaced is always a multiple of PRUNE_BATCH: (total - keep) rounded down. Between
 * batches nothing old changes; when the count of images crosses the next threshold, one batch flips at once.
 * So the prefix breaks once per PRUNE_BATCH new screenshots (at the oldest image still kept), never per call,
 * and between breaks 2..6 images are sent instead of all of them.
 *
 * Pure and deterministic from the projected rows (no clock, no stored state): `buildContext` and
 * `hydrateContext` both project through it, so a replay or a hydration yields the same bytes. Only tool-result
 * image blocks change; text blocks, user images and every other message stay exactly as they are.
 */
export function pruneOldScreenshots(messages: Message[], keep = KEEP_SCREENSHOTS, batch = PRUNE_BATCH): Message[] {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'toolResult') total += message.content.filter((block) => block.type === 'image').length;
  }
  const over = total - keep;
  const remove = over > 0 ? over - (over % batch) : 0;
  if (remove === 0) return messages;
  let seen = 0;
  return messages.map((message) => {
    if (message.role !== 'toolResult' || seen >= remove || !message.content.some((block) => block.type === 'image')) return message;
    const content = message.content.map((block): TextContent | ImageContent => {
      if (block.type !== 'image') return block;
      seen += 1;
      return seen <= remove
        ? { type: 'text', text: `[image #${seen} omitted: older images are dropped to keep the context small; take a new screenshot, or web_fetch the image URL again, to see it]` }
        : block;
    });
    return { ...message, content };
  });
}
