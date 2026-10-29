import { z } from 'zod';
import type { Store, ToolContext, ToolResult, TranscriptEntry } from '../../../contracts/index.js';
import { observationFingerprint } from './browser-advance-observation.js';
import type { AdvanceObservation, AdvanceProgressEntry, RunBrowserAdvanceOptions } from './browser-advance-types.js';

const short = z.string().max(160);
const historyEntrySchema = z.object({
  goal: short, action: z.enum(['click', 'type', 'fill', 'get_text']),
  target: z.array(z.object({ role: short, label: short })).max(3),
  omittedTargets: z.number().int().nonnegative(),
  observed: z.array(z.object({ kind: short, control: short.optional(), now: short.optional() })).max(3),
  result: z.enum(['changed', 'no-observed-effect', 'read', 'error', 'suspended']),
});
export type AdvanceHistoryEntry = z.infer<typeof historyEntrySchema>;
export const HISTORY_MAX_STEPS = 12;
const checkpointSchema = z.object({
  version: z.literal(1), ownerId: z.string(), agentId: z.string(), conversationId: z.string(), runId: z.string(), stepId: z.string(),
  on: z.enum(['sandbox', 'mac']), tab: z.string(), fingerprint: z.string(),
  totalSteps: z.number().int().nonnegative(), entries: z.array(historyEntrySchema).max(HISTORY_MAX_STEPS),
});
export type AdvanceHistory = {
  entries: AdvanceHistoryEntry[]; totalSteps: number; continuity: 'matched' | 'changed';
};

function clip(value: string): string { return value.slice(0, 160); }

/** No old ref, input value or executable argument is carried forward. */
export function progressHistory(goal: string, progress: AdvanceProgressEntry[]): AdvanceHistoryEntry[] {
  return progress.map(entry => ({
    goal: clip(goal), action: entry.action,
    target: entry.target.slice(0, 3).map(target => ({ role: clip(target.role), label: clip(target.label) })),
    omittedTargets: Math.max(0, entry.target.length - 3),
    observed: entry.observed.slice(0, 3).map(effect => ({
      kind: clip(typeof effect['kind'] === 'string' ? effect['kind'] : 'change'),
      ...(typeof effect['control'] === 'string' ? { control: clip(effect['control']) } : {}),
      ...(effect['now'] === undefined ? {} : { now: clip(JSON.stringify(effect['now'])) }),
    })),
    result: entry.result,
  }));
}

export async function readAdvanceHistory(ctx: Pick<ToolContext, 'ownerId' | 'agentId' | 'conversationId' | 'runId' | 'stepId' | 'store'>, on: 'sandbox' | 'mac', page: AdvanceObservation): Promise<AdvanceHistory | undefined> {
  const sessionKey = ctx.agentId + ':' + ctx.conversationId;
  const scoped = ctx.store.forOwner?.(ctx.ownerId) ?? ctx.store;
  const rows = await scoped.list('transcripts', { where: { kind: sessionKey }, orderBy: 'at', order: 'desc', limit: 32 });
  for (const row of rows.items.sort((left, right) => right.seq - left.seq)) {
    if (row.sessionKey !== sessionKey) continue;
    const parsed = checkpointSchema.safeParse(row.toolState?.['browserAdvance']);
    if (!parsed.success) continue;
    const history = parsed.data;
    if (history.ownerId !== ctx.ownerId || history.agentId !== ctx.agentId || history.conversationId !== ctx.conversationId
      || history.runId !== ctx.runId || history.stepId === ctx.stepId || history.on !== on || history.tab !== page.page.tab) continue;
    return { entries: history.entries, totalSteps: history.totalSteps,
      continuity: history.fingerprint === observationFingerprint(page) ? 'matched' : 'changed' };
  }
  return undefined;
}

export function advanceCheckpoint(options: RunBrowserAdvanceOptions, page: AdvanceObservation, history: AdvanceHistory | undefined, progress: AdvanceProgressEntry[]): unknown {
  if (options.stepId === undefined || progress.length === 0) return undefined;
  return {
    version: 1, ownerId: options.ownerId, agentId: options.agentId, conversationId: options.conversationId, runId: options.runId, stepId: options.stepId,
    on: options.args.on ?? 'sandbox', tab: page.page.tab, fingerprint: observationFingerprint(page),
    totalSteps: (history?.totalSteps ?? 0) + progress.length,
    entries: [...(history?.entries ?? []), ...progressHistory(options.args.goal, progress)].slice(-HISTORY_MAX_STEPS),
  };
}

/** Kept on the internal transcript row, outside the model message and public step summary. */
export async function persistAdvanceHistory(store: Store, entries: TranscriptEntry[], result: ToolResult, scope: { ownerId: string; agentId: string; runId: string; stepId: string }): Promise<void> {
  const encoded = result.details?.['browserAdvanceCheckpoint'];
  if (typeof encoded !== 'string') return;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return; }
  const parsed = checkpointSchema.safeParse(value);
  if (!parsed.success) return;
  const checkpoint = parsed.data;
  if (checkpoint.ownerId !== scope.ownerId || checkpoint.agentId !== scope.agentId || checkpoint.runId !== scope.runId || checkpoint.stepId !== scope.stepId) return;
  for (const entry of entries) {
    if (entry.sessionKey !== scope.agentId + ':' + checkpoint.conversationId) continue;
    await store.patch('transcripts', entry.id, { toolState: { ...entry.toolState, browserAdvance: checkpoint } });
  }
}
