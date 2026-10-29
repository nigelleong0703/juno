/**
 * The owner's buttons on proactive items (BACKEND §5.10, `POST /v1/proactive/feedback`):
 *   useful  - a positive signal; an idea counts as handled
 *   not_now - snooze the item and its topic for 14 days (dedupe only, no rule)
 *   less / never - write a rule (source = the button and what it was pressed on); an idea also leaves the list
 * The only way a button writes a rule is a `less` or `never` press: nothing is inferred from silence or from a single "not now".
 */
import type { Idea, ProactiveFeedbackInput, ProactiveFeedbackResult } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import type { HomeDeps } from '../home/service.js';
import { SNOOZE_DAYS, normalizeKey } from '../ideas/cooldown.js';
import { logProactive, ownerLog, recordRule, todayFor } from './service.js';
import { toPublicRule } from './rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KIND_LABEL = { idea: 'the idea', message: 'the message', feed: 'the Feed post' } as const;
const ACTION_LABEL = { less: 'Less like this', never: 'Never' } as const;
/** A topic key ("priya-move") as the owner reads it in Settings ("Priya move"). */
const readable = (topic: string): string => {
  const text = topic.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const LOG_TYPE = { 'daily-check': 'Daily proactive checks', 'goal-checkin': 'Goal check-ins' } as const;

interface Target {
  /** What the item is about, and the kind of message it is; a `less` / `never` rule is written about one of them. */
  topic: string;
  type: string;
  /** The item's own title, for the rule's source line. */
  title: string;
  idea?: Idea;
  itemId: string;
}

export type FeedbackFailure = { code: 'TARGET_NOT_FOUND'; message: string };

const firstLine = (markdown: string): string => (markdown.split('\n').map((line) => line.replace(/^[#*_`>\-\s]+/, '').trim()).find((line) => line.length > 0) ?? '').slice(0, 80);

async function ownConversation(store: Store, ownerId: string, conversationId: string): Promise<boolean> {
  return docOwner(await store.get('conversations', conversationId)) === ownerId;
}

async function resolveTarget(store: Store, ownerId: string, input: ProactiveFeedbackInput): Promise<Target | undefined> {
  const { kind, id } = input.target;
  if (kind === 'idea') {
    const idea = await store.get('ideas', id);
    return idea === null || docOwner(idea) !== ownerId ? undefined : { topic: idea.topic ?? idea.text, type: 'Ideas like "' + idea.text + '"', title: idea.text, idea, itemId: id };
  }
  if (kind === 'feed') {
    const post = await store.get('feedPosts', id);
    if (post === null || docOwner(post) !== ownerId) return undefined;
    const routine = post.routineId === undefined ? null : await store.get('routines', post.routineId);
    return { topic: post.title, type: routine?.name ?? 'Feed posts', title: post.title, itemId: id };
  }
  const item = await store.get('items', id);
  if (item === null || item.type !== 'agent_message' || !(await ownConversation(store, ownerId, item.conversationId))) return undefined;
  const logged = (await ownerLog(store, ownerId, ['daily-check', 'goal-checkin'])).find((row) => row.itemId === id || (item.runId !== undefined && row.runId === item.runId));
  const run = item.runId === undefined ? null : await store.get('runs', item.runId);
  const type = logged === undefined ? (run === null ? 'Messages like this one' : run.title.replace(/^(?:Goal|Routine|Monitor|Calendar|Event): /, '')) : LOG_TYPE[logged.kind as keyof typeof LOG_TYPE];
  return { topic: logged?.topic ?? firstLine(item.markdown), type, title: firstLine(item.markdown), itemId: id };
}

export async function applyFeedback(deps: HomeDeps, ownerId: string, input: ProactiveFeedbackInput, now: Date): Promise<ProactiveFeedbackResult | FeedbackFailure> {
  const { store } = deps;
  const target = await resolveTarget(store, ownerId, input);
  if (target === undefined) return { code: 'TARGET_NOT_FOUND', message: 'Nothing to give feedback on: no such ' + input.target.kind + ' for this account' };
  const date = await todayFor(store, ownerId, now);
  const at = now.toISOString();
  const setIdea = async (patch: Partial<Idea>): Promise<Idea | undefined> => {
    if (target.idea === undefined) return undefined;
    const updated = await store.patch('ideas', target.idea.id, { ...patch, updatedAt: at });
    await store.emit({ type: 'idea.updated', idea: updated });
    return updated;
  };
  const { action } = input;
  if (action === 'useful') {
    const idea = await setIdea({ status: 'accepted', outcome: 'useful' });
    if (idea === undefined) await logProactive(store, { ownerId, kind: 'useful', itemId: target.itemId, topic: target.topic, date, at });
    return idea === undefined ? {} : { idea };
  }
  if (action === 'not_now') {
    const idea = await setIdea({ status: 'dismissed', outcome: 'not_now' });
    if (idea === undefined) await logProactive(store, { ownerId, kind: 'snooze', itemId: target.itemId, topic: normalizeKey(target.topic), until: new Date(now.getTime() + SNOOZE_DAYS * DAY_MS).toISOString(), date, at });
    return idea === undefined ? {} : { idea };
  }
  const scope = input.scope ?? 'topic';
  const { rule } = await recordRule(deps, ownerId, {
    kind: action === 'never' ? 'dont' : 'less', scope, text: scope === 'topic' ? readable(target.topic) : target.type,
    source: 'You tapped ' + ACTION_LABEL[action] + ' on ' + KIND_LABEL[input.target.kind] + ' "' + target.title + '"',
  }, now);
  const idea = await setIdea({ status: 'dismissed' });
  return { rule: toPublicRule(rule, date), ...(idea === undefined ? {} : { idea }) };
}
