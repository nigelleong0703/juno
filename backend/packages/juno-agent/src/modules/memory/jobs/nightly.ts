/**
 * The nightly job (BACKEND §5.4), after Muse's "A nightly dream reviews recent conversations and writes guidance for future
 * sessions": code counts how the user writes, one model call writes the day's dream, a second rewrites ALIGNMENT_SYNTHESIS.md
 * (how to talk to this user) from the last week of dreams and the stated preferences.
 * Before the dream, the memory items are tidied (`tidy.ts`) and the topic summaries written (`topics.ts`) whenever any item changed since
 * the last tidy, with or without chat that day; the dream and the synthesis still wait for fresh chat (or a forget).
 */
import type { MemoryClaimStatus } from '@agent-desktop/public-contracts';
import { readOwnerTimeZone } from '../../../execution/brain/context.js';
import { readRowsUnder } from '../../home/mirror.js';
import { ALIGNMENT_FILE, localDate } from '../../home/paths.js';
import { harnessText } from '../../harness/loader.js';
import { editHomeFile } from '../files.js';
import { listAll } from '../util.js';
import { sanitizeAlignment } from './alignment.js';
import { itemsSince } from './gather.js';
import { appendReceipt } from './receipt.js';
import { computeStyleStats, type StatItem } from './stats.js';
import { CONFIRM_FILE, tidyItems } from './tidy.js';
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
  const changedItems = (await deps.memory.items.listItems(ownerId)).some((item) => checkpoint.tidiedAt === undefined || item.updatedAt > checkpoint.tidiedAt);
  if (!fresh && !forgotten && !backfill && !changedItems) return { outcome: 'skipped', checkpoint };

  const receipt: string[] = [];
  let tidyState: Pick<NightlyCheckpoint, 'tidiedAt' | 'tidyVersion'> = { ...(checkpoint.tidiedAt === undefined ? {} : { tidiedAt: checkpoint.tidiedAt }), ...(checkpoint.tidyVersion === undefined ? {} : { tidyVersion: checkpoint.tidyVersion }) };
  if (backfill || changedItems) {
    const tidied = await tidyItems(deps, { ownerId, agentId, now, backfill });
    if (tidied !== null) {
      receipt.push('Tidied memory: merged ' + String(tidied.merged) + ', expired ' + String(tidied.expired) + ', sorted ' + String(tidied.sorted) + ', reworded ' + String(tidied.reworded) + ', ' + String(tidied.confirm.length) + ' to confirm.');
      const topics = await summarizeTopics(deps, { ownerId, agentId });
      if (topics !== null) receipt.push('Topic summaries: wrote ' + String(topics.written) + ', removed ' + String(topics.removed) + '.');
      // Everything the tidy and the summaries changed is already seen: only a later change makes the next night tidy again.
      const newest = (await deps.memory.items.listItems(ownerId)).reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), now.toISOString());
      tidyState = { tidiedAt: newest, tidyVersion: TIDY_VERSION };
    } else if (!fresh && !forgotten) {
      return { outcome: 'failed', checkpoint };
    }
  }
  const tidyOnly = !fresh && !forgotten;
  if (tidyOnly) {
    await appendReceipt(deps, { ownerId, agentId, job: 'dream', now, ...(timeZone === undefined ? {} : { timeZone }), lines: receipt });
    return { outcome: 'done', checkpoint: { ...checkpoint, ...tidyState, at: now.toISOString(), date } };
  }
  const rows = await readRowsUnder(store, ownerId, '');
  const file = (path: string): string => rows.find((row) => row.path === path)?.content.trim() ?? '';
  const preferences = file('memory/bank/preferences.md');

  if (fresh) {
    const stats = computeStyleStats(await statItems(deps, day), now);
    const conversation = day.map((item) => (item.role === 'user' ? 'USER' : 'ASSISTANT') + ' ' + item.at + ': ' + item.text).join('\n');
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
      '## Stated preferences (lines end with their claim id)\n' + (preferences || '(none)'),
      '## To confirm (things to ask the user about naturally)\n' + (file(CONFIRM_FILE) || '(none)'),
      '## Assistants\n' + input.agents.map((agent) => agent.name + '（' + agent.id + '）').join('\n'),
      '## Current ALIGNMENT_SYNTHESIS.md\n' + (file(ALIGNMENT_FILE) || '(none)'),
    ].join('\n\n'),
  });
  if (alignment === null || alignment.text.trim().length === 0) return { outcome: 'failed', checkpoint: { ...checkpoint, ...tidyState } };
  await recordJobUsage(store, { ownerId, agentId, label: 'Memory: alignment', reply: alignment, startedAt, finishedAt: new Date() });
  const statuses = new Map<string, MemoryClaimStatus>((await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId).map((claim) => [claim.id, claim.status]));
  const text = sanitizeAlignment(alignment.text, { agentIds: new Set(input.agents.map((agent) => agent.id)), statuses });
  await editHomeFile(deps, { ownerId, agentId, path: ALIGNMENT_FILE }, () => text);
  receipt.push('Rewrote ' + ALIGNMENT_FILE + ' (' + String(text.split('\n').length - 1) + ' lines).');
  await appendReceipt(deps, { ownerId, agentId, job: 'dream', now, ...(timeZone === undefined ? {} : { timeZone }), lines: receipt });
  const newest = day[day.length - 1]?.at ?? checkpoint.itemsAt;
  return { outcome: 'done', checkpoint: { ...(newest === undefined ? {} : { itemsAt: newest }), at: now.toISOString(), date, ...tidyState } };
}
