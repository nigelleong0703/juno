import { createHash } from 'node:crypto';
import type { Message } from '@earendil-works/pi-ai';
import type { AssistantTurn, Tool } from '../../contracts/index.js';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/** Fingerprints only; never log message content, schema bodies or credentials. */
export function requestCacheShape(messages: readonly Message[], tools: readonly Tool[]): { toolSchemaHash: string; systemPromptHash: string; toolCount: number } {
  return {
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
