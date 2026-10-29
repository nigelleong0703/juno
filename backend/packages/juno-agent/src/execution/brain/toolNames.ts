/**
 * OpenAI-compatible endpoints reject tool names outside ^[a-zA-Z0-9_-]+$ (and longer than 64
 * chars), but the sandbox registry uses dotted names like `shell.run`. This module derives a valid
 * protocol name per internal name and maps it back, so internal names stay stable.
 */

import { createHash } from 'node:crypto';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_TOOL_NAME_LENGTH = 64;
const SHORT_HASH_LENGTH = 8;

/** Deterministic suffix for names that must be truncated, so the same input always maps the same way. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, SHORT_HASH_LENGTH);
}

function baseName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized.length <= MAX_TOOL_NAME_LENGTH) return sanitized;
  const suffix = `_${shortHash(name)}`;
  return `${sanitized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** Keep the name within the OpenAI limit while the uniqueness loop appends its counter. */
function withSuffix(base: string, index: number): string {
  const suffix = `_${index}`;
  if (base.length + suffix.length <= MAX_TOOL_NAME_LENGTH) return `${base}${suffix}`;
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

export interface ToolNameAliases {
  /** Internal name -> name sent to the model; already-valid names stay as they are, unknown ones sanitize. */
  toProtocol(name: string): string;
  /** Name returned by the model -> internal name; throws for names the registry does not know. */
  fromProtocol(name: string): string;
}

/**
 * Build one injective mapping for a registry's tool names. Names that are already valid keep their
 * identity; names that are not are sanitized (dots become underscores). Already-valid names reserve
 * their protocol name first, so a dotted name that would collide with one (foo_bar vs foo.bar) gets
 * a distinct suffixed name instead of silently merging.
 */
export function createToolNameAliases(internalNames: readonly string[]): ToolNameAliases {
  const protocolByInternal = new Map<string, string>();
  const internalByProtocol = new Map<string, string>();
  const used = new Set<string>();
  const rename: string[] = [];

  for (const name of internalNames) {
    if (VALID_TOOL_NAME.test(name) && name.length <= MAX_TOOL_NAME_LENGTH) {
      if (protocolByInternal.has(name)) continue;
      protocolByInternal.set(name, name);
      internalByProtocol.set(name, name);
      used.add(name);
      continue;
    }
    if (!rename.includes(name)) rename.push(name);
  }

  for (const name of rename) {
    const base = baseName(name);
    let candidate = base;
    let index = 1;
    while (used.has(candidate)) {
      candidate = withSuffix(base, index);
      index += 1;
    }
    used.add(candidate);
    protocolByInternal.set(name, candidate);
    internalByProtocol.set(candidate, name);
  }

  return {
    toProtocol(name) {
      // Registry names map to their alias. Anything else (for example history for a tool that is no
      // longer registered) is still sanitized, without stealing a registered alias, so the wire
      // never carries an invalid name and known tools stay distinct.
      const known = protocolByInternal.get(name);
      if (known !== undefined) return known;
      const sanitized = baseName(name);
      if (!used.has(sanitized)) return sanitized;
      const suffix = `_${shortHash(name)}`;
      return `${sanitized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    },
    fromProtocol(name) {
      const internal = internalByProtocol.get(name);
      if (internal === undefined) {
        throw new Error(`Model requested unknown tool "${name}"; it is not in the tool registry`);
      }
      return internal;
    },
  };
}

/** Rewrite tool-call and tool-result names in replayed history to their protocol names. */
export function aliasToolNamesInMessages(messages: readonly Message[], aliases: ToolNameAliases): Message[] {
  return messages.map(message => {
    if (message.role === 'assistant') {
      return {
        ...message,
        content: message.content.map(block =>
          block.type === 'toolCall' ? { ...block, name: aliases.toProtocol(block.name) } : block),
      };
    }
    if (message.role === 'toolResult') {
      return { ...message, toolName: aliases.toProtocol(message.toolName) };
    }
    return message;
  });
}

/** Rewrite the tool-call names in a provider result back to their internal registry names. */
export function aliasToolNamesInResult(message: AssistantMessage, aliases: ToolNameAliases): AssistantMessage {
  return {
    ...message,
    content: message.content.map(block =>
      block.type === 'toolCall' ? { ...block, name: aliases.fromProtocol(block.name) } : block),
  };
}
