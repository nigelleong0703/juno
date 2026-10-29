/**
 * The goal part of the chat digest (BACKEND §5.10): the goals the user asked the assistant to work on over time get their progress from
 * the digest's answer. Code, not the model, decides what is written: a new goal needs the user's own words asking for it, and quoted
 * answers must be things the user really said. Writes go through `writeGoal`, the same way `goal_update` writes.
 */
import { z } from 'zod';
import type { Goal } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import type { SourceItem } from '../memory/jobs/gather.js';
import { agentGoals } from './index.js';
import { writeGoal, type GoalExtraActivity } from './write.js';

const TIMELINE_ENTRIES = 5;
const MAX_QUOTES = 3;
const QUOTE_CHARS = 300;
const MAX_MILESTONES = 7;

const entrySchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(400),
  milestones: z.array(z.object({ title: z.string().trim().min(1).max(160), status: z.enum(['done', 'doing', 'todo']) })).min(1),
  note: z.string().trim().min(1).max(300).optional(),
  evidence: z.string().trim().min(1).optional(),
  quotes: z.array(z.object({ milestone: z.string().trim().min(1).max(160), text: z.string().trim().min(1) })).optional(),
});

/** Whitespace-normalised, so line breaks and double spaces never make a genuine quote fail the check. */
const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** One goal as the digest's prompt shows it: its id, state, milestones and the latest timeline entries. */
export function describeGoal(goal: Goal): string {
  const milestones = (goal.milestones ?? []).map((milestone) => '  - [' + milestone.status + '] ' + milestone.title).join('\n');
  const timeline = (goal.activity ?? []).slice(0, TIMELINE_ENTRIES).map((entry) => '  ' + entry.at.slice(0, 10) + ' ' + norm(entry.text)).join('\n');
  return '[' + goal.id + '] ' + goal.title + ' (' + goal.status + ')\nSummary: ' + (goal.summary || '(none)')
    + (milestones.length > 0 ? '\nMilestones:\n' + milestones : '') + (timeline.length > 0 ? '\nTimeline, newest first:\n' + timeline : '');
}

/** The agent's goals the digest may update: active or paused. */
export async function workingGoals(store: Store, ownerId: string, agentId: string): Promise<Goal[]> {
  return (await agentGoals(store, ownerId, agentId)).filter((goal) => goal.status === 'active' || goal.status === 'paused');
}

/**
 * Writes the goal entries of one digest answer. A new goal without the user's words asking for it is dropped; a quote is kept only when
 * the user said it. Returns the goals written.
 */
export async function recordGoals(
  store: Store,
  input: { ownerId: string; agentId: string; conversationId: string; items: readonly SourceItem[]; goals: readonly Goal[]; entries: readonly unknown[]; log?: (fields: Record<string, unknown>, message: string) => void },
): Promise<Goal[]> {
  const { ownerId, agentId, conversationId, goals } = input;
  const userTexts = input.items.filter((item) => item.role === 'user').map((item) => norm(item.text));
  const saidByUser = (text: string): boolean => userTexts.some((said) => said.includes(norm(text)));
  const written: Goal[] = [];
  for (const raw of input.entries) {
    const candidate = entrySchema.safeParse(raw);
    if (!candidate.success) {
      input.log?.({ ownerId, conversationId }, 'chat digest dropped a malformed goal entry');
      continue;
    }
    const entry = candidate.data;
    const existing = goals.find((goal) => goal.id === entry.id) ?? goals.find((goal) => norm(goal.title).toLowerCase() === norm(entry.title).toLowerCase());
    if (existing === undefined && (entry.evidence === undefined || !saidByUser(entry.evidence))) {
      input.log?.({ ownerId, conversationId, title: entry.title }, 'chat digest dropped a new goal without evidence in the user messages');
      continue;
    }
    const milestones = entry.milestones.slice(0, MAX_MILESTONES);
    const quotes = (entry.quotes ?? []).filter((quote) => saidByUser(quote.text)).slice(0, MAX_QUOTES);
    const unchanged = existing !== undefined && norm(existing.summary) === norm(entry.summary) && entry.note === undefined && quotes.length === 0
      && JSON.stringify((existing.milestones ?? []).map((m) => [norm(m.title), m.status])) === JSON.stringify(milestones.map((m) => [norm(m.title), m.status]));
    if (unchanged) continue;
    // A new goal's timeline starts with "created"; the note goes after it (on an existing goal the note is the update's own entry).
    const extra: GoalExtraActivity[] = [
      ...(existing === undefined && entry.note !== undefined ? [{ kind: 'note' as const, text: entry.note }] : []),
      ...quotes.map((quote) => ({ kind: 'quote' as const, actor: 'user' as const, text: norm(quote.text).slice(0, QUOTE_CHARS), milestoneTitle: quote.milestone })),
    ];
    const result = await writeGoal({ store }, { ownerId, agentId }, {
      ...(existing === undefined ? {} : { id: existing.id }), title: existing?.title ?? entry.title, summary: entry.summary, milestones,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    }, extra);
    if (result.ok) written.push(result.goal);
  }
  return written;
}
