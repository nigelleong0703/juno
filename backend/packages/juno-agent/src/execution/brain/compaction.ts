import { randomUUID } from 'node:crypto';
import type { Compaction, ResultTrim, Store, TranscriptEntry } from '../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { estimateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { parseMessage } from './messages.js';
import { findCutPoint } from './pi-context/cut.js';
import { renderTranscriptEntries } from './pi-context/serialize.js';
import { buildProjectedMessages, buildSummaryRequestMessage, summaryMessage as piSummaryMessage } from './pi-context/projection.js';
const COMPACTION_SCAN_LIMIT = 500;
/** Raw turns kept after a compaction; a quarter of a small window at most. */
const MAX_TAIL_TOKENS = 24_000;
const MIN_TAIL_TOKENS = 512;
export interface CompactionPlan {
  older: TranscriptEntry[];
  kept: TranscriptEntry[];
  uptoSeq: number;
}
export function compactionTailBudgetTokens(contextWindow: number | undefined): number {
  if (contextWindow === undefined || contextWindow <= 0) return MAX_TAIL_TOKENS;
  return Math.max(MIN_TAIL_TOKENS, Math.min(Math.floor(contextWindow / 4), MAX_TAIL_TOKENS));
}
/** One session's compaction checkpoints through the indexed `kind` (= sessionKey), never a table scan. */
async function listCompactions(store: Store, sessionKey: string): Promise<Compaction[]> {
  const found: Compaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list('compactions', { where: { kind: sessionKey }, limit: COMPACTION_SCAN_LIMIT, cursor });
    found.push(...page.items.filter((item) => item.sessionKey === sessionKey));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}
export async function readLatestCompaction(store: Store, sessionKey: string): Promise<Compaction | null> {
  let latest: Compaction | null = null;
  for (const item of await listCompactions(store, sessionKey)) {
    if (latest === null || item.epoch >= latest.epoch) latest = item;
  }
  return latest;
}
/** The checkpoint a journaled context named by epoch (a newer one may exist by now). */
export async function readCompaction(store: Store, sessionKey: string, epoch: number): Promise<Compaction | null> {
  return (await listCompactions(store, sessionKey)).find((item) => item.epoch === epoch) ?? null;
}
/** `trims` are the earlier stubs of rows the cut keeps (the kept tail stays as small as it was); stubs of rows the summary covers are dropped. */
export function createCompaction(sessionKey: string, epoch: number, summary: string, uptoSeq: number, recentUsers?: string[], trims?: ResultTrim[]): Compaction {
  const kept = trims?.filter((trim) => trim.seq > uptoSeq) ?? [];
  return {
    id: 'cmp_' + randomUUID(), sessionKey, epoch, summary, uptoSeq,
    ...(recentUsers === undefined || recentUsers.length === 0 ? {} : { recentUsers }),
    ...(kept.length === 0 ? {} : { trims: kept }),
    createdAt: new Date().toISOString(),
  };
}
/**
 * The checkpoint of a result trim (BACKEND §3.5.2b): `previous` carried forward as it is (summary, cut, recent user messages, earlier
 * stubs) and `trims` added on top, one epoch later. With no earlier checkpoint it covers nothing (`uptoSeq: -1`) and has no summary.
 */
export function createTrim(sessionKey: string, epoch: number, previous: Compaction | null, added: ResultTrim[]): Compaction {
  return {
    id: 'cmp_' + randomUUID(), sessionKey, epoch,
    ...(previous?.summary === undefined ? {} : { summary: previous.summary }),
    uptoSeq: previous?.uptoSeq ?? -1,
    ...(previous?.recentUsers === undefined ? {} : { recentUsers: previous.recentUsers }),
    trims: [...(previous?.trims ?? []), ...added],
    createdAt: new Date().toISOString(),
  };
}
export function summaryMessage(summary: string): Message {
  return piSummaryMessage(summary);
}
export function buildMessages(system: Message | undefined, summary: string | undefined, entries: TranscriptEntry[], recentUsers?: string[], boundaryTimestamp?: number): Message[] {
  return buildProjectedMessages(system, summary, entries, recentUsers, boundaryTimestamp);
}
function parseMessageSafe(value: unknown): Message | undefined {
  try {
    return parseMessage(value);
  } catch {
    return undefined;
  }
}
export function parseMessagesLenient(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  const messages: Message[] = [];
  for (const raw of value) {
    const parsed = parseMessageSafe(raw);
    if (parsed !== undefined) messages.push(parsed);
  }
  return messages;
}
function entryRole(entry: TranscriptEntry): string | undefined {
  const parsed = parseMessageSafe(entry.message);
  return parsed === undefined ? undefined : parsed.role;
}
export function estimateMessagesTokens(messages: Message[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}

/**
 * Measured-aware token estimate for compaction pressure. Content chars/4
 * undercounts real provider input (images count as ~1200 tokens here while
 * the provider measures far more; trims shrink the estimate further), but
 * the transcript keeps the provider-measured prefix on every assistant turn.
 * The SDK combines that last measured prefix with trailing content estimates
 * and already drops it when a newer prefix message was inserted after it, so
 * a stale pre-boundary snapshot cannot inflate the result. Rewritten rows
 * carry stable boundary timestamps for exactly this: trim stubs are stamped
 * with their checkpoint's creation time, pruned image rows with the
 * timestamp of the screenshot that triggered the batch, and the
 * summary/recent-users prefix with the checkpoint's creation time. A
 * measurement taken before the boundary is therefore older than the
 * rewritten prefix and ignored; one taken after stays valid. The only extra
 * guard here is a model change (different counters), which falls back to
 * the content estimate.
 */
export function estimateContextTokensForPressure(messages: Message[], currentModelId?: string): number {
  const contentEstimate = estimateMessagesTokens(messages);
  try {
    const measured = estimateContextTokens(messages);
    if (measured.lastUsageIndex === null || measured.lastUsageIndex === undefined) return contentEstimate;
    const last = messages[measured.lastUsageIndex];
    if (last === undefined || last.role !== 'assistant') return contentEstimate;
    if (currentModelId !== undefined && last.model !== currentModelId) {
      return contentEstimate;
    }
    if (!Number.isFinite(measured.tokens) || measured.tokens <= 0) return contentEstimate;
    return Math.max(contentEstimate, measured.tokens);
  } catch {
    return contentEstimate;
  }
}
export function planCompaction(entries: TranscriptEntry[], tailBudgetTokens: number): CompactionPlan | null {
  if (entries.length < 2) return null;
  const cut = findCutPoint(entries, 0, entries.length, tailBudgetTokens);
  let splitIndex = cut.firstKeptEntryIndex;
  if (splitIndex <= 0) return null;
  if (splitIndex >= entries.length) return null;
  let guard = splitIndex;
  while (guard < entries.length) {
    const entry = entries[guard];
    if (entry === undefined) break;
    if (entryRole(entry) !== 'toolResult') break;
    guard += 1;
  }
  splitIndex = guard;
  if (splitIndex <= 0) return null;
  if (splitIndex >= entries.length) return null;
  const older = entries.slice(0, splitIndex);
  const kept = entries.slice(splitIndex);
  const last = older[older.length - 1];
  if (last === undefined) return null;
  return { older, kept, uptoSeq: last.seq };
}
export function renderTranscript(entries: TranscriptEntry[]): string {
  return renderTranscriptEntries(entries);
}
export function summaryRequestMessage(older: TranscriptEntry[], previousSummary: string | undefined): Message {
  return buildSummaryRequestMessage(older, previousSummary);
}
