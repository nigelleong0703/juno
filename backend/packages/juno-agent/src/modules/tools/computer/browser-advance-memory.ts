import { createHash } from 'node:crypto';
import type { RunBrowserAdvanceOptions } from './browser-advance-types.js';

const MEMORY_MAX_RUNS = 256;
const MEMORY_TTL_MS = 30 * 60_000;

interface StageMemory {
  fingerprint: string;
  blocked?: string;
  blockedByStepId?: string;
  touchedAt: number;
}

const stages = new Map<string, StageMemory>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stageKey(options: RunBrowserAdvanceOptions, tab: string, values: Record<string, string>): string {
  const sortedValues = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return [
    options.ownerId,
    options.agentId,
    options.runId,
    options.args.on ?? 'sandbox',
    tab,
    digest(options.args.goal),
    digest(JSON.stringify(sortedValues)),
  ].join('\u0000');
}

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of stages) {
    if (now - entry.touchedAt > MEMORY_TTL_MS) stages.delete(key);
  }
  while (stages.size > MEMORY_MAX_RUNS) {
    const oldest = [...stages].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
    if (oldest === undefined) break;
    stages.delete(oldest[0]);
  }
}

/**
 * A memo may suppress a NEW parent step, but never replay of the step that wrote it. Replaying the
 * same step must reach the same journaled native decision and child fences in the same order.
 */
export function rememberedStage(
  options: RunBrowserAdvanceOptions,
  tab: string,
  stageFingerprint: string,
  values: Record<string, string>,
): string | undefined {
  prune();
  const entry = stages.get(stageKey(options, tab, values));
  if (entry === undefined || entry.fingerprint !== stageFingerprint) return undefined;
  if (entry.blockedByStepId !== undefined && entry.blockedByStepId === options.stepId) return undefined;
  return entry.blocked;
}

export function rememberStage(
  options: RunBrowserAdvanceOptions,
  tab: string,
  stageFingerprint: string,
  values: Record<string, string>,
  blocked?: string,
): void {
  prune();
  stages.set(stageKey(options, tab, values), {
    fingerprint: stageFingerprint,
    ...(blocked === undefined ? {} : { blocked, blockedByStepId: options.stepId }),
    touchedAt: Date.now(),
  });
}

/** Test seam only. */
export function resetBrowserAdvanceMemoryForTests(): void {
  stages.clear();
}
