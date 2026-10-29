/**
 * The nightly tidy of the memory items (BACKEND §5.4 "Nightly tidy"): one model call reads every active item of the owner, whatever its
 * source (the digest, memory_note, the migration from MEMORY.md), and proposes merges of near-duplicates (the newest wins a contradiction),
 * items gone stale, things worth confirming with the person, and the topic and wording of items that lack them. The code checks every
 * proposal against the stored items before applying it, so a bad answer changes nothing:
 * - an item is only merged with another about the same person, for the same audience (and agent, and sensitivity). Nothing is ever moved
 *   to another audience: the tidy changes an item's text, topic, evidence and status, never who may hear it;
 * - a merged or dropped item that came through a claim keeps its claim in step (superseded, or given the merged wording);
 * - only a stale preference or circumstance that was not seen again for STALE_DAYS expires.
 * The first run for an owner is also the backfill: items without a topic get one, and items still worded the old way ("User wants…") are
 * rewritten. A model that does not answer changes nothing and leaves the backfill due.
 */
import { z } from 'zod';
import type { ItemFile, ItemTopic, MemoryItem } from '@agent-desktop/memory-graph/memory';
import type { MemoryClaimDoc } from '../../../contracts/memory.js';
import { harnessText } from '../../harness/loader.js';
import { editHomeFile } from '../files.js';
import { ownerNameOf } from '../owner.js';
import { renderViews } from '../views.js';
import { OLD_WORDING, TOPIC_RULES, topicSchema, WORDING_RULES } from '../wording.js';
import { STALE_DAYS } from './claims.js';
import { jsonObjectIn } from './model-json.js';
import type { JobDeps } from './types.js';
import { recordJobUsage } from './usage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CONFIRM_FILE = 'memory/to-confirm.md';
const MAX_CONFIRM = 5;
/** Items shown to the model at once: those that still need a topic or new wording first, then the most recently seen. */
const MAX_ITEMS = 400;
/** Stale items only expire from these files: they hold what the person is like, and nothing keeps them true. */
const EXPIRING = new Set<ItemFile>(['bank:preferences', 'bank:circumstances']);

const proposalSchema = z.object({
  merge: z.array(z.object({
    keep: z.string(), drop: z.array(z.string()).min(1), text: z.string().trim().min(1).max(500), topic: topicSchema.optional().catch(undefined),
  })).default([]),
  stale: z.array(z.string()).default([]),
  confirm: z.array(z.string().trim().min(1).max(300)).default([]),
  fix: z.array(z.object({ id: z.string(), topic: topicSchema.optional().catch(undefined), text: z.string().trim().min(1).max(500).optional() })).default([]),
});

export interface TidyResult {
  merged: number;
  expired: number;
  /** Items given a topic. */
  sorted: number;
  /** Items worded again. */
  reworded: number;
  confirm: string[];
}

/** Who may hear an item and whom it is about: items merge only within one bucket. */
const bucketOf = (item: MemoryItem): string => [item.aboutPersonId ?? '', item.audience, item.agentId ?? '', item.sensitive ? 's' : ''].join('|');
const needsWork = (item: MemoryItem): boolean => item.topic === null || OLD_WORDING.test(item.text);

const uniqueEvidence = (all: MemoryClaimDoc['evidence']): MemoryClaimDoc['evidence'] => all.filter((entry, i) => all.findIndex((other) => other.itemId === entry.itemId && other.quote === entry.quote) === i);

/** Null when the model gave no usable answer (nothing was changed). `backfill`: the first tidy of this owner, where old wordings are rewritten whatever the model says about them. */
export async function tidyItems(deps: JobDeps, input: { ownerId: string; agentId: string; now: Date; backfill: boolean }): Promise<TidyResult | null> {
  const { store, model, memory } = deps;
  const { ownerId, agentId, now, backfill } = input;
  const empty: TidyResult = { merged: 0, expired: 0, sorted: 0, reworded: 0, confirm: [] };
  const active = await memory.items.listItems(ownerId, { status: 'active' });
  if (active.length === 0 || (active.length < 2 && !active.some(needsWork))) return empty;

  const claims = new Map<string, MemoryClaimDoc>();
  for (const item of active) {
    const claim = item.claimId === null ? null : await store.get('memoryClaims', item.claimId);
    if (claim !== null && claim.ownerId === ownerId) claims.set(claim.id, claim);
  }
  /** The last time the item was seen: its own change, or its claim being reinforced. */
  const lastSeen = (item: MemoryItem): string => {
    const claimSeen = item.claimId === null ? '' : claims.get(item.claimId)?.updatedAt ?? '';
    return claimSeen > item.updatedAt ? claimSeen : item.updatedAt;
  };

  const shown = [...active].sort((a, b) => Number(needsWork(b)) - Number(needsWork(a)) || lastSeen(b).localeCompare(lastSeen(a))).slice(0, MAX_ITEMS)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const byId = new Map(shown.map((item) => [item.id, item]));
  const people = new Map((await memory.identity.listPeople(ownerId)).map((person) => [person.id, person]));
  const buckets = new Map<string, string>();
  const legend: string[] = [];
  const bucketName = (item: MemoryItem): string => {
    const key = bucketOf(item);
    let name = buckets.get(key);
    if (name === undefined) {
      name = 'b' + String(buckets.size + 1);
      buckets.set(key, name);
      const about = item.aboutPersonId === null ? 'the person being helped' : people.get(item.aboutPersonId)?.isOwner === true ? 'the person being helped' : people.get(item.aboutPersonId)?.name ?? 'someone';
      legend.push(name + ' = about ' + about + '; heard by ' + item.audience + (item.agentId === null ? '' : '; private to one assistant') + (item.sensitive ? '; sensitive' : ''));
    }
    return name;
  };
  const listing = shown.map((item) => [item.id, bucketName(item), item.topic ?? '?', lastSeen(item).slice(0, 10), String(item.evidence?.length ?? 0) + ' quotes', item.text.replace(/\s+/g, ' ').trim()].join(' | '));
  const ownerName = await ownerNameOf(store, ownerId);
  const startedAt = new Date();
  const reply = await model.complete({
    agentId, sessionKey: 'memory:tidy:' + ownerId, system: harnessText('job.tidy.system', { maxConfirm: String(MAX_CONFIRM), wordingRules: WORDING_RULES, topicRules: TOPIC_RULES }),
    prompt: ['## The person being helped\n' + ownerName, '## Buckets\n' + legend.join('\n'), '## Active items (id | bucket | topic | last seen | evidence | text)\n' + listing.join('\n')].join('\n\n'),
  });
  if (reply === null) return null;
  await recordJobUsage(store, { ownerId, agentId, label: 'Memory: tidy', reply, startedAt, finishedAt: new Date() });
  const parsed = proposalSchema.safeParse(jsonObjectIn(reply.text));
  if (!parsed.success) return null;

  const stamp = now.toISOString();
  const used = new Set<string>();
  let merged = 0;
  let expired = 0;
  let sorted = 0;
  let reworded = 0;
  let changed = false;
  /** Ends an item (merged away or expired) and its claim with it. */
  const end = async (item: MemoryItem): Promise<void> => {
    await memory.items.retract(ownerId, item.id);
    const claim = item.claimId === null ? undefined : claims.get(item.claimId);
    if (claim !== undefined) await store.put('memoryClaims', { ...claim, status: 'superseded', updatedAt: stamp }, { status: 'superseded' });
    changed = true;
  };

  for (const entry of parsed.data.merge) {
    const group = [entry.keep, ...entry.drop].map((id) => byId.get(id)).filter((item, i, all): item is MemoryItem => item !== undefined && !used.has(item.id) && all.indexOf(item) === i);
    // Every id must be an item still free, and all of them one bucket: another person's, another audience's or another assistant's item never merges in.
    if (group.length !== new Set([entry.keep, ...entry.drop]).size || group.length < 2 || group[0]?.id !== entry.keep) continue;
    if (new Set(group.map(bucketOf)).size !== 1) continue;
    // The newest item survives (it wins a contradiction); it takes the merged wording and the evidence of all.
    const survivor = group.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const topic: ItemTopic | null = entry.topic ?? survivor.topic ?? group.find((item) => item.topic !== null)?.topic ?? null;
    const evidence = uniqueEvidence(group.flatMap((item) => item.evidence ?? []));
    await memory.items.updateItem(ownerId, survivor.id, { text: entry.text, topic, evidence: evidence.length === 0 ? null : evidence });
    const claim = survivor.claimId === null ? undefined : claims.get(survivor.claimId);
    if (claim !== undefined) {
      const all = uniqueEvidence(group.flatMap((item) => (item.claimId === null ? [] : claims.get(item.claimId)?.evidence ?? [])));
      await store.put('memoryClaims', { ...claim, text: entry.text, evidence: all, updatedAt: stamp }, { status: 'active' });
    }
    for (const loser of group.filter((item) => item.id !== survivor.id)) await end(loser);
    for (const item of group) used.add(item.id);
    merged += 1;
    changed = true;
  }

  for (const id of parsed.data.stale) {
    const item = byId.get(id);
    // Only what was not seen again for STALE_DAYS expires; the model cannot expire a fresh item.
    if (item === undefined || used.has(id) || !EXPIRING.has(item.file) || now.getTime() - Date.parse(lastSeen(item)) < STALE_DAYS * DAY_MS) continue;
    await end(item);
    used.add(id);
    expired += 1;
  }

  for (const entry of parsed.data.fix) {
    const item = byId.get(entry.id);
    if (item === undefined || used.has(entry.id)) continue;
    const topic = item.topic === null ? entry.topic : undefined;
    // A rewrite counts only when the item is worded the old way (or in the backfill) and the new text no longer is.
    const text = entry.text !== undefined && entry.text !== item.text && (backfill || OLD_WORDING.test(item.text)) && !OLD_WORDING.test(entry.text) ? entry.text : undefined;
    if (topic === undefined && text === undefined) continue;
    await memory.items.updateItem(ownerId, item.id, { ...(topic === undefined ? {} : { topic }), ...(text === undefined ? {} : { text }) });
    const claim = text === undefined || item.claimId === null ? undefined : claims.get(item.claimId);
    if (claim !== undefined && text !== undefined) await store.put('memoryClaims', { ...claim, text, updatedAt: stamp }, { status: 'active' });
    if (topic !== undefined) sorted += 1;
    if (text !== undefined) {
      reworded += 1;
      changed = true;
    }
  }

  if (changed) await renderViews(deps, { ownerId, agentId });
  // The list is replaced each night, so answered or outdated questions do not pile up.
  const confirm = parsed.data.confirm.slice(0, MAX_CONFIRM);
  await editHomeFile(deps, { ownerId, agentId, path: CONFIRM_FILE }, (content) => {
    if (confirm.length === 0) return content === '' ? null : '# To confirm\n\n(nothing right now)\n';
    return '# To confirm\n\nAsk about these naturally, once, when it fits the conversation. Do not interrogate.\n\n' + confirm.map((line) => '- ' + line).join('\n') + '\n';
  });
  return { merged, expired, sorted, reworded, confirm };
}
