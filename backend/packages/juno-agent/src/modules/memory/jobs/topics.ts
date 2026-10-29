/**
 * The topic summaries of the Memory page (BACKEND §5.4 "Nightly tidy"): one to three sentences per topic, written in the second person
 * for the person reading ("You're building muscle and cutting sugar; you train four times a week."). One model call writes every topic
 * whose items changed since its summary (or has none yet). Only items the person alone may hear or anyone may hear go in: a group's
 * items are left out, so a summary never carries what was said in a group into the person's page as their own.
 */
import { z } from 'zod';
import { ITEM_TOPICS, type ItemTopic, type MemoryItem } from '@agent-desktop/memory-graph/memory';
import { harnessText } from '../../harness/loader.js';
import { jsonObjectIn } from './model-json.js';
import type { JobDeps } from './types.js';
import { recordJobUsage } from './usage.js';
import { TOPIC_RULES } from '../wording.js';
import { cleanMarkup } from '../topic-markup.js';

/** Items of one topic the model reads: the most recently changed. */
const MAX_PER_TOPIC = 60;
/** The readable length of a summary (the markers do not count). */
const MAX_SUMMARY_CHARS = 1200;

const replySchema = z.object({ summaries: z.record(z.string(), z.string()) });

export interface TopicsResult {
  written: number;
  removed: number;
}

/** Null when the model gave no usable answer (the summaries wait for the next night). */
export async function summarizeTopics(deps: JobDeps, input: { ownerId: string; agentId: string }): Promise<TopicsResult | null> {
  const { model, memory, store } = deps;
  const { ownerId, agentId } = input;
  // The person's own page: what only they may hear, and what anyone may. A group's items stay out.
  const heard = (await memory.items.listItems(ownerId, { status: 'active' })).filter((item) => item.audience === 'owner' || item.audience === 'public');
  const summaries = new Map((await memory.items.listTopicSummaries(ownerId)).map((entry) => [entry.topic, entry]));
  const byTopic = new Map<ItemTopic, MemoryItem[]>();
  for (const item of heard) byTopic.set(item.topic ?? 'other', [...(byTopic.get(item.topic ?? 'other') ?? []), item]);

  let removed = 0;
  for (const topic of summaries.keys()) {
    if (byTopic.has(topic)) continue;
    await memory.items.deleteTopicSummary(ownerId, topic);
    removed += 1;
  }
  const due = ITEM_TOPICS.filter((topic) => {
    const mine = byTopic.get(topic);
    const current = summaries.get(topic);
    return mine !== undefined && (current === undefined || mine.some((item) => item.updatedAt > current.updatedAt));
  });
  if (due.length === 0) return { written: 0, removed };

  // The ids the model was shown, per topic: a marker may only name one of them.
  const shown = new Map<ItemTopic, Set<string>>();
  const sections = due.map((topic) => {
    const read = [...(byTopic.get(topic) ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_PER_TOPIC).reverse();
    shown.set(topic, new Set(read.map((item) => item.id)));
    const lines = read.map((item) => '- ' + item.id + ' | ' + item.text.replace(/\s+/g, ' ').trim());
    return '## ' + topic + '\nSummary now: ' + (summaries.get(topic)?.summary ?? '(none)') + '\nLines:\n' + lines.join('\n');
  });
  const startedAt = new Date();
  const reply = await model.complete({ agentId, sessionKey: 'memory:topics:' + ownerId, system: harnessText('job.topics.system', { topicRules: TOPIC_RULES }), prompt: sections.join('\n\n') });
  if (reply === null) return null;
  await recordJobUsage(store, { ownerId, agentId, label: 'Memory: topic summaries', reply, startedAt, finishedAt: new Date() });
  const parsed = replySchema.safeParse(jsonObjectIn(reply.text));
  if (!parsed.success) return null;

  let written = 0;
  for (const topic of due) {
    // Stored with its markers; one that names an id the model was not shown (or another topic's) is plain text.
    const summary = cleanMarkup(parsed.data.summaries[topic] ?? '', shown.get(topic) ?? new Set(), MAX_SUMMARY_CHARS);
    if (summary === '') continue;
    // Written no earlier than the newest line it read, so the same lines are not summarised again tomorrow.
    const newest = (byTopic.get(topic) ?? []).reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), '');
    const at = new Date().toISOString();
    await memory.items.putTopicSummary(ownerId, topic, summary, newest > at ? newest : at);
    written += 1;
  }
  return { written, removed };
}
