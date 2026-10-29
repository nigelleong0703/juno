// Owner-scoped, run-scoped memo for discovery rankings: the same owner, agent,
// run and exact catalog fingerprint plus the exact query reuses one Jev decision
// instead of paying for it twice. Bounded (at most 64 entries, short TTL) and
// in-memory only: nothing is logged, and a changed catalog or permission set
// fingerprints differently and misses on purpose. tool_search and skill_search
// share this module so a prepared ranking can serve an identical later search.
import { createHash } from 'node:crypto';
import type { RankOutcome, RankReason } from './candidateRanking.js';
import type { Tool } from '../../../contracts/index.js';
const MAX_MEMO_ENTRIES = 64;
const MEMO_TTL_MS = 5 * 60 * 1000;
interface MemoEntry {
  order: number[];
  semantic: boolean;
  reason: RankReason;
  omitted: number;
  relevantCount?: number;
  expiresAt: number;
}
const memos = new Map<string, MemoEntry>();
// Fingerprint of an exact candidate set in exact order: names, descriptions,
// visibility, and an caller-supplied identity snapshot (parameters, access,
// origin). Order is significant because cached orders are indices into this
// exact array; any catalog, permission, schema, or enumeration change misses
// instead of reusing a stale ranking.
export interface FingerprintCandidate {
  name: string;
  description: string;
  hidden?: boolean;
  identity?: unknown;
}
export function fingerprintCandidates(entries: readonly FingerprintCandidate[]): string {
  return createHash('sha1').update(JSON.stringify(entries.map((entry) => [entry.name, entry.description, entry.hidden === true, entry.identity === undefined ? null : entry.identity]))).digest('hex');
}
export function discoveryMemoKey(parts: readonly string[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}
export interface DiscoveryScope {
  ownerId: string;
  agentId: string;
  runId: string;
  scope: string;
  fingerprint: string;
  query: string;
}
// Memo key for one owner, agent, run, candidate set, and exact query. Empty
// owner, agent, or run means no memo (never a shared fallback entry).
export function discoveryScopeKey(input: DiscoveryScope): string | undefined {
  if (input.ownerId === '' || input.agentId === '' || input.runId === '') return undefined;
  return discoveryMemoKey([input.ownerId, input.agentId, input.runId, input.scope, input.fingerprint, input.query]);
}
// Identity snapshot for one tool candidate: parameters, MCP/access markers, and
// the origin record. Shared by preparation and tool_search so both sides hash
// the same bytes for the same catalog.
export function toolIdentityFingerprint(tool: Tool): unknown {
  const origin = tool.origin;
  return {
    parameters: tool.parameters,
    mcp: tool.mcp === true,
    origin: origin === undefined ? null : {
      connectionId: origin.connectionId,
      catalogId: origin.catalogId === undefined ? null : origin.catalogId,
      account: origin.account === undefined ? null : origin.account,
      toolName: origin.toolName,
      access: origin.access,
    },
  };
}
export function readDiscoveryMemo(key: string, now: number = Date.now()): RankOutcome | undefined {
  const found = memos.get(key);
  if (found === undefined) return undefined;
  if (found.expiresAt <= now) {
    memos.delete(key);
    return undefined;
  }
  return { order: [...found.order], semantic: found.semantic, reason: found.reason, omitted: found.omitted, relevantCount: found.relevantCount };
}
export function writeDiscoveryMemo(key: string, outcome: RankOutcome, now: number = Date.now()): void {
  if (memos.size >= MAX_MEMO_ENTRIES) {
    const oldest = memos.keys().next();
    if (!oldest.done) memos.delete(oldest.value);
  }
  memos.set(key, { order: [...outcome.order], semantic: outcome.semantic, reason: outcome.reason, omitted: outcome.omitted, relevantCount: outcome.relevantCount, expiresAt: now + MEMO_TTL_MS });
}
export function clearDiscoveryMemo(): void {
  memos.clear();
}
