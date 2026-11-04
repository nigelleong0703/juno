import { createHash } from 'node:crypto';
import type { Message } from '@earendil-works/pi-ai';
import type { AssistantTurn, Tool } from '../../contracts/index.js';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/**
 * Hash of the history a request shares with the next one: everything up to the last assistant or tool-result message, so the notes and the
 * new user line that follow it (a real run's, or the warm-up's probe) are left out. Equal hashes on a warm-up and the run after it mean
 * the provider's cache prefix matches; the system row and the tools are compared by their own hashes.
 */
function historyPrefixHash(messages: readonly Message[]): string {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === 'user') end -= 1;
  return hash(messages.slice(0, end).map((message) => ({ ...message, timestamp: 0 })));
}

/** Fingerprints only; never log message content, schema bodies or credentials. */
export function requestCacheShape(messages: readonly Message[], tools: readonly Tool[]): { toolSchemaHash: string; systemPromptHash: string; toolCount: number; prefixHash: string } {
  return {
    prefixHash: historyPrefixHash(messages),
    toolSchemaHash: hash(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))),
    systemPromptHash: hash(messages.filter(message => message.role === 'system').map(message => message.content)),
    toolCount: tools.length,
  };
}

/** Weighted cache reads / all input; unknown usage must never appear as a measured zero hit rate. */
export function cacheReadMetrics(usage: AssistantTurn['usage']): { cacheUsageKnown: boolean; totalInputTokens?: number; cacheReadFraction?: number } {
  if (usage.measured !== true) return { cacheUsageKnown: false };
  const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (!Number.isFinite(total) || total < 0) return { cacheUsageKnown: false };
  return { cacheUsageKnown: true, totalInputTokens: total,
    ...(total === 0 ? {} : { cacheReadFraction: (usage.cacheReadTokens ?? 0) / total }) };
}
