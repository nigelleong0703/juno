/**
 * The nightly job (BACKEND §5.4), after Muse's "A nightly dream reviews recent conversations and writes guidance for future
 * sessions": code counts how the user writes, one model call writes the day's dream, a second rewrites ALIGNMENT_SYNTHESIS.md
 * (how to talk to this user) from the last week of dreams and the stated preferences.
 * Before the dream, the memory items are tidied (`tidy.ts`) and the topic summaries written (`topics.ts`) whenever any item changed since
 * the last tidy, with or without chat that day; the dream and the synthesis still wait for fresh chat (or a forget).
 */
import { readOwnerTimeZone } from '../../../execution/brain/context.js';
import type { MemoryClaimDoc } from '../../../contracts/memory.js';
import { LOG_SOURCE_PREFIX } from '../evidence.js';
import { readRowsUnder } from '../../home/mirror.js';
import { ALIGNMENT_FILE, localDate } from '../../home/paths.js';
import { harnessText } from '../../harness/loader.js';
import { editHomeFile } from '../files.js';
import { listAll } from '../util.js';
import { ALIGNMENT_VERSION, cleanAlignment, evidenceItemIds, evidenceItemIdsOfFile, gateRules, loadUserSources, parseAlignmentAnswer, renderAlignment } from './alignment.js';
import { applyClaims, readClaimsContext } from './claims.js';
import { itemsSince, sourceItemOf } from './gather.js';
import { appendReceipt } from './receipt.js';
import { computeStyleStats, type StatItem } from './stats.js';
import { CONFIRM_FILE, DATED_KINDS, tidyItems } from './tidy.js';
import { summarizeTopics } from './topics.js';
import type { JobDeps, JobOutcome, NightlyCheckpoint } from './types.js';
import { recordJobUsage } from './usage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bump to run the backfill (and a full tidy) once more for every owner. */
export const TIDY_VERSION = 1;
/** Characters of the day's conversation shown to the dream. */
const DREAM_SOURCE_CHARS = 40_000;
/** Dreams the synthesis is rewritten from. */
const DREAMS_READ = 7;
const PROACTIVE_RUN_KINDS = new Set(['routine', 'scheduled', 'background']);

export interface NightlyResult {
  outcome: JobOutcome;
  checkpoint: NightlyCheckpoint;
}

async function statItems(deps: JobDeps, items: Awaited<ReturnType<typeof itemsSince>>): Promise<StatItem[]> {
  const kinds = new Map<string, boolean>();
  const out: StatItem[] = [];
  for (const item of items) {
    let proactive = false;
    if (item.role === 'agent' && item.runId !== undefined) {
      if (!kinds.has(item.runId)) kinds.set(item.runId, PROACTIVE_RUN_KINDS.has((await deps.store.get('runs', item.runId))?.kind ?? 'chat'));
      proactive = kinds.get(item.runId) === true;
    }
    out.push({ id: item.id, conversationId: item.conversationId, at: item.at, role: item.role === 'agent' ? 'agent' : 'user', text: item.text, ...(proactive ? { proactive } : {}) });
  }
  return out;
}

export async function runNightly(
  deps: JobDeps,
  input: { ownerId: string; agentId: string; agents: ReadonlyArray<{ id: string; name: string }>; checkpoint: NightlyCheckpoint },
): Promise<NightlyResult> {
  const { store, model } = deps;
  const { ownerId, agentId, checkpoint } = input;
  const now = (deps.now ?? (() => new Date()))();
  const timeZone = await readOwnerTimeZone(store, ownerId);
  const date = localDate(now, timeZone);
  // Only the owner's words and the assistants' replies shape the synthesis; other senders never do.
  const day = (await itemsSince(store, ownerId, new Date(now.getTime() - DAY_MS).toISOString(), DREAM_SOURCE_CHARS)).filter((item) => item.role !== 'other');
  const fresh = day.some((item) => checkpoint.itemsAt === undefined || item.at > checkpoint.itemsAt);
  const claims = (await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId);
  const forgotten = claims.some((claim) => claim.status === 'retracted' && (checkpoint.at === undefined || claim.updatedAt > checkpoint.at));
  // The tidy runs when any memory item changed since the last one (a note, a digest, a retraction, an edit), chat or no chat, and once
  // for every owner as the backfill; the dream and the synthesis below still wait for fresh chat or a forget.
  const backfill = checkpoint.tidyVersion !== TIDY_VERSION;
  const allItems = await deps.memory.items.listItems(ownerId);
  const changedItems = allItems.some((item) => checkpoint.tidiedAt === undefined || item.updatedAt > checkpoint.tidiedAt);
  // A plan ("flies to KL on the 6th") goes out of date with no change to any item: while one is active the tidy looks once a day.
  const datedDue = checkpoint.tidiedOn !== date && allItems.some((item) => item.status === 'active' && DATED_KINDS.has(item.kind));
  // A stored synthesis is checked again once per ALIGNMENT_VERSION, whether or not anything happened that day.
  const regate = checkpoint.alignmentVersion !== ALIGNMENT_VERSION;
  if (!fresh && !forgotten && !backfill && !changedItems && !datedDue && !regate) return { outcome: 'skipped', checkpoint };

  const receipt: string[] = [];
  let tidyState: Pick<NightlyCheckpoint, 'tidiedAt' | 'tidiedOn' | 'tidyVersion'> = { ...(checkpoint.tidiedAt === undefined ? {} : { tidiedAt: checkpoint.tidiedAt }), ...(checkpoint.tidiedOn === undefined ? {} : { tidiedOn: checkpoint.tidiedOn }), ...(checkpoint.tidyVersion === undefined ? {} : { tidyVersion: checkpoint.tidyVersion }) };
  if (backfill || changedItems || datedDue) {
    const tidied = await tidyItems(deps, { ownerId, agentId, now, today: date, backfill });
    if (tidied !== null) {
      receipt.push('Tidied memory: merged ' + String(tidied.merged) + ', expired ' + String(tidied.expired) + ', past ' + String(tidied.past) + ', sorted ' + String(tidied.sorted) + ', reworded ' + String(tidied.reworded) + ', ' + String(tidied.confirm.length) + ' to confirm.');
      const topics = await summarizeTopics(deps, { ownerId, agentId });
      if (topics !== null) receipt.push('Topic summaries: wrote ' + String(topics.written) + ', removed ' + String(topics.removed) + '.');
      // Everything the tidy and the summaries changed is already seen: only a later change makes the next night tidy again.
      const newest = (await deps.memory.items.listItems(ownerId)).reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), now.toISOString());
      tidyState = { tidiedAt: newest, tidiedOn: date, tidyVersion: TIDY_VERSION };
    } else if (!fresh && !forgotten) {
      return { outcome: 'failed', checkpoint };
    }
  }
  // What is already in the file is checked every night with the same rules as a new proposal; what goes is logged, never silent.
  const cleaned = await cleanStoredAlignment(deps, { ownerId, agentId, agents: input.agents });
  receipt.push(...cleaned.map((change) => 'Reply style: ' + change));
  const tidyOnly = !fresh && !forgotten;
  if (tidyOnly) {
    await appendReceipt(deps, { ownerId, agentId, job: 'dream', now, ...(timeZone === undefined ? {} : { timeZone }), lines: receipt });
    return { outcome: 'done', checkpoint: { ...checkpoint, ...tidyState, at: now.toISOString(), date, alignmentVersion: ALIGNMENT_VERSION } };
  }
  const rows = await readRowsUnder(store, ownerId, '');
  const file = (path: string): string => rows.find((row) => row.path === path)?.content.trim() ?? '';
  const preferences = file('memory/bank/preferences.md');

  if (fresh) {
    const stats = computeStyleStats(await statItems(deps, day), now);
    const conversation = day.map((item) => '[' + item.id + '] ' + (item.role === 'user' ? 'USER' : 'ASSISTANT') + ' ' + item.at + ': ' + item.text).join('\n');
    const startedAt = new Date();
    const dream = await model.complete({
      agentId, sessionKey: 'memory:dream:' + ownerId, system: harnessText('job.nightly.dream'),
      prompt: ['## Counted facts\n' + JSON.stringify(stats, null, 1), '## Conversation (last day)\n' + conversation, '## Known preferences\n' + (preferences || '(none)')].join('\n\n'),
    });
    if (dream === null) return { outcome: 'failed', checkpoint: { ...checkpoint, ...tidyState } };
    await recordJobUsage(store, { ownerId, agentId, label: 'Memory: nightly dream', reply: dream, startedAt, finishedAt: new Date() });
    await editHomeFile(deps, { ownerId, agentId, path: 'dreams/' + date + '.md' }, () => '# Dream, ' + date + '\n\n' + dream.text.trim() + '\n');
    receipt.push('Counted ' + String(stats.userMessages) + ' messages of yours and wrote dreams/' + date + '.md.');
  }

  const dreams = rows.filter((row) => row.path.startsWith('dreams/') && row.path !== 'dreams/' + date + '.md').sort((a, b) => b.path.localeCompare(a.path)).slice(0, DREAMS_READ - 1).reverse();
  const today = (await readRowsUnder(store, ownerId, 'dreams/' + date + '.md'))[0];
  const dreamsText = [...dreams, ...(today === undefined ? [] : [today])].map((row) => '### ' + row.path + '\n' + row.content.trim()).join('\n\n');
  const startedAt = new Date();
  const alignment = await model.complete({
    agentId, sessionKey: 'memory:alignment:' + ownerId, system: harnessText('job.nightly.alignment'),
    prompt: [
      '## Dreams\n' + (dreamsText || '(none)'),
      '## The user\'s own messages, last day (id | text): the only place a quote may come from\n' + (day.filter((item) => item.role === 'user').map((item) => item.id + ' | ' + item.text.replace(/\s+/g, ' ')).join('\n') || '(none)'),
      '## Stated preferences (lines end with their claim id)\n' + (preferences || '(none)'),
      '## Evidence of those claims (claim id | message id | quote)\n' + (claimEvidenceLines(claims, preferences) || '(none)'),
      '## To confirm (things to ask the user about naturally)\n' + (file(CONFIRM_FILE) || '(none)'),
      '## Assistants\n' + input.agents.map((agent) => agent.name + '（' + agent.id + '）').join('\n'),
      '## Current ALIGNMENT_SYNTHESIS.md\n' + (file(ALIGNMENT_FILE) || '(none)'),
    ].join('\n\n'),
  });
  if (alignment === null || alignment.text.trim().length === 0) return { outcome: 'failed', checkpoint: { ...checkpoint, ...tidyState } };
  await recordJobUsage(store, { ownerId, agentId, label: 'Memory: alignment', reply: alignment, startedAt, finishedAt: new Date() });
  const proposal = parseAlignmentAnswer(alignment.text);
  if (proposal === undefined) {
    deps.log?.({ ownerId }, 'nightly: the alignment answer was not the JSON asked for, the synthesis is left as it was');
    return { outcome: 'failed', checkpoint: { ...checkpoint, ...tidyState } };
  }
  const claimsById = new Map((await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId).map((claim) => [claim.id, claim]));
  const sources = await loadUserSources(store, ownerId, evidenceItemIds(proposal.rules, claimsById));
  const gated = gateRules(proposal.rules, { agentIds: new Set(input.agents.map((agent) => agent.id)), claims: claimsById, sources });
  const text = renderAlignment({ rules: gated.kept, confirm: proposal.confirm, agents: input.agents, date });
  await editHomeFile(deps, { ownerId, agentId, path: ALIGNMENT_FILE }, () => text);
  for (const rejection of gated.rejected) deps.log?.({ ownerId, reason: rejection.reason }, 'nightly: reply-style rule not written: ' + rejection.text);
  if (gated.rejected.length > 0) receipt.push('Reply style: not written (' + String(gated.rejected.length) + '): ' + gated.rejected.map((rejection) => '"' + rejection.text + '" (' + rejection.reason + ')').join('; '));
  if (gated.facts.length > 0) {
    const items = await Promise.all(gated.facts.flatMap((fact) => fact.evidence.map((entry) => store.get('items', entry.itemId))));
    const found = items.flatMap((item) => { const source = item === null ? undefined : sourceItemOf(item, ownerId); return source === undefined ? [] : [source]; });
    const { context } = await readClaimsContext(deps, { ownerId, agentId, items: found, agents: input.agents });
    const written = await applyClaims(deps, { ownerId, agentId, items: found, context, now, claims: gated.facts.map((fact) => ({ text: fact.text, evidence: fact.evidence, confidence: 0.7, target: 'circumstances', basis: 'explicit' })) });
    receipt.push('Reply style: facts about you went to memory, not the reply style: ' + (written.lines.join('; ') || 'none written'));
  }
  receipt.push('Rewrote ' + ALIGNMENT_FILE + ' (' + String(text.split('\n').length - 1) + ' lines).');
  await appendReceipt(deps, { ownerId, agentId, job: 'dream', now, ...(timeZone === undefined ? {} : { timeZone }), lines: receipt });
  const newest = day[day.length - 1]?.at ?? checkpoint.itemsAt;
  return { outcome: 'done', checkpoint: { ...(newest === undefined ? {} : { itemsAt: newest }), at: now.toISOString(), date, alignmentVersion: ALIGNMENT_VERSION, ...tidyState } };
}

/** The lines of the claims the preferences cite: claim id | message id | quote, for the model to quote from. */
function claimEvidenceLines(claims: ReadonlyArray<MemoryClaimDoc>, preferences: string): string {
  return claims.filter((claim) => claim.status === 'active' && preferences.includes(claim.id))
    .flatMap((claim) => claim.evidence.filter((entry) => !entry.itemId.startsWith(LOG_SOURCE_PREFIX)).map((entry) => claim.id + ' | ' + entry.itemId + ' | ' + entry.quote.replace(/\s+/g, ' ')))
    .slice(0, 100).join('\n');
}

/** Re-checks the stored synthesis and writes it back when lines or headings had to go; returns what changed. */
async function cleanStoredAlignment(deps: JobDeps, input: { ownerId: string; agentId: string; agents: ReadonlyArray<{ id: string; name: string }> }): Promise<string[]> {
  const { ownerId, agentId, agents } = input;
  const current = (await readRowsUnder(deps.store, ownerId, ALIGNMENT_FILE))[0]?.content ?? '';
  if (current.trim() === '') return [];
  const claims = new Map((await listAll(deps.store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId).map((claim) => [claim.id, claim]));
  const sources = await loadUserSources(deps.store, ownerId, evidenceItemIdsOfFile(current, claims));
  const result = cleanAlignment(current, { agents, claims, sources });
  if (result.changes.length === 0) return [];
  await editHomeFile(deps, { ownerId, agentId, path: ALIGNMENT_FILE }, () => result.text);
  for (const change of result.changes) deps.log?.({ ownerId }, 'nightly: ' + change);
  return result.changes;
}
