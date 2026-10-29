import { randomUUID } from 'node:crypto';
import type { Compaction, Store, TranscriptEntry } from '../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
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
export function createCompaction(sessionKey: string, epoch: number, summary: string, uptoSeq: number, recentUsers?: string[]): Compaction {
  return {
    id: 'cmp_' + randomUUID(), sessionKey, epoch, summary, uptoSeq,
    ...(recentUsers === undefined || recentUsers.length === 0 ? {} : { recentUsers }),
    createdAt: new Date().toISOString(),
  };
}
export function summaryMessage(summary: string): Message {
  return piSummaryMessage(summary);
}
export function buildMessages(system: Message | undefined, summary: string | undefined, entries: TranscriptEntry[], recentUsers?: string[]): Message[] {
  return buildProjectedMessages(system, summary, entries, recentUsers);
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
