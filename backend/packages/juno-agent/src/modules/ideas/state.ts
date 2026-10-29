/** What the daily ideas job knows about before it proposes anything (BACKEND §5.10): ideas that went unanswered, and what the owner already has going. */
import type { Idea } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { itemsSince } from '../memory/jobs/gather.js';
import { listAll } from '../memory/util.js';
import { IGNORED_DAYS } from './cooldown.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHAT_WEEK_DAYS = 7;
const CHAT_TOPIC_CHARS = 100;
const CHAT_TOPIC_LINES = 25;
const CALENDAR_DAYS = 14;
const LISTED = 15;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

/** An idea that stayed open for 14 days is "shown and ignored": it leaves the list, and dedupe treats it as such (one re-offer later). */
export async function expireIgnored(store: Store, ideas: readonly Idea[], now: Date): Promise<Idea[]> {
  const out: Idea[] = [];
  for (const idea of ideas) {
    if (idea.status !== 'open' || now.getTime() - Date.parse(idea.createdAt) < IGNORED_DAYS * DAY_MS) {
      out.push(idea);
      continue;
    }
    const updated = await store.patch('ideas', idea.id, { status: 'dismissed', outcome: 'ignored', updatedAt: now.toISOString() });
    await store.emit({ type: 'idea.updated', idea: updated });
    out.push(updated);
  }
  return out;
}

/**
 * Text for the model of what the owner already has going, so an idea does not duplicate it: their routines and monitors, the
 * assistants' upcoming calendar items, running tasks, and what they talked about in their chats this week.
 */
export async function alreadyHandled(store: Store, ownerId: string, agentIds: ReadonlySet<string>, now: Date): Promise<string> {
  const routines = (await listAll(store, 'routines')).filter((routine) => docOwner(routine) === ownerId && routine.enabled)
    .map((routine) => '- ' + (routine.monitor === undefined ? 'routine' : 'monitor') + ' "' + routine.name + '": ' + clip(routine.instructions, 120)).slice(0, LISTED);
  const horizon = new Date(now.getTime() + CALENDAR_DAYS * DAY_MS).toISOString();
  const calendar = (await listAll(store, 'agentCalendar')).filter((item) => docOwner(item) === ownerId && item.status === 'scheduled' && item.at >= now.toISOString() && item.at <= horizon)
    .sort((a, b) => a.at.localeCompare(b.at)).map((item) => '- ' + item.at.slice(0, 10) + ' ' + clip(item.title, 100)).slice(0, LISTED);
  const tasks = (await listAll(store, 'agentTasks', { where: { status: 'running' } })).filter((task) => agentIds.has(task.agentId))
    .map((task) => '- ' + clip(task.title, 100)).slice(0, LISTED);
  const chats = (await itemsSince(store, ownerId, new Date(now.getTime() - CHAT_WEEK_DAYS * DAY_MS).toISOString(), 10_000))
    .filter((item) => item.role === 'user').map((item) => '- ' + clip(item.text, CHAT_TOPIC_CHARS)).slice(-CHAT_TOPIC_LINES);
  const part = (title: string, lines: string[]): string => '### ' + title + '\n' + (lines.join('\n') || '(none)');
  return [part('Routines and monitors', routines), part('Upcoming calendar items (next 14 days)', calendar), part('Running tasks', tasks), part('What they talked about in the last week (their own messages)', chats)].join('\n\n');
}
