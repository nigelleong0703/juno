/**
 * Goal wakes (BACKEND §5.10): the one place that decides who is woken, in which chat and with what brief. The per-user tick
 * (`collectDueWakes`, called from MemoryTimer), the "Check now" route and the plan-on-create path all build their wake here.
 * Nothing in this file knows about Restate; the callers hand the wakes to a Session (Restate) or the Enqueuer (agentd).
 */
import { randomUUID } from 'node:crypto';
import type { Agent, Conversation, Goal, GoalMilestone } from '@agent-desktop/public-contracts';
import { sessionKey, type Enqueuer, type Store, type WakeEvent } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { listAll } from '../memory/util.js';
import { rulesForWake } from '../proactive/service.js';
import { clampNextCheck, dueDeadlines, isCheckinDue } from './schedule.js';
import { harnessText } from '../harness/loader.js';

export type CheckinReason = 'plan' | 'scheduled' | 'manual' | 'deadline';

/** Wakes one tick may start for a user; the rest stay due and go at the next hourly tick. */
const MAX_WAKES_PER_TICK = 5;
const RECENT_ACTIVITY = 3;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function milestoneLine(milestone: GoalMilestone): string {
  return '- [' + milestone.status + '] ' + oneLine(milestone.title) + (milestone.due === undefined ? '' : ' (due ' + milestone.due + ')') + ' id=' + milestone.id;
}

/** What to do for each reason: the checkin.* units (the scheduled and manual ones carry the shared checkin.rules). */
const instructionsFor = (reason: CheckinReason): string => {
  switch (reason) {
    case 'plan': return harnessText('checkin.plan');
    // Only the scheduled check-in is a run with finish_quietly (isQuietStartWake); the manual one is answered, so its text never names the tool.
    case 'scheduled': return harnessText('checkin.scheduled', { rules: harnessText('checkin.rules', { quiet: ' ' + harnessText('checkin.quiet_step') }) });
    case 'manual': return harnessText('checkin.manual', { rules: harnessText('checkin.rules', { quiet: '' }) });
    case 'deadline': return harnessText('checkin.deadline');
  }
};

/** The brief the agent wakes with: the goal as it stands now, what to do for this reason, and the facts the notify rule turns on. */
export function checkinText(goal: Goal, reason: CheckinReason, now: Date): string {
  const lines = ['Goal "' + oneLine(goal.title) + '" (' + goal.kind + ', id=' + goal.id + '). Now: ' + now.toISOString() + '.'];
  if (goal.summary.length > 0) lines.push('Where it stands: ' + oneLine(goal.summary));
  if (goal.milestones !== undefined && goal.milestones.length > 0) lines.push('Milestones:\n' + goal.milestones.map(milestoneLine).join('\n'));
  const recent = (goal.activity ?? []).slice(0, RECENT_ACTIVITY);
  if (recent.length > 0) lines.push('Recent timeline:\n' + recent.map((entry) => '- ' + entry.at + ' ' + entry.actor + ': ' + oneLine(entry.text)).join('\n'));
  const deadlines = dueDeadlines(goal, now);
  if (reason !== 'deadline' && deadlines.length > 0) lines.push(harnessText('checkin.due_soon', { deadlines: deadlines.map((milestone) => oneLine(milestone.title)).join('; ') }));
  lines.push(instructionsFor(reason));
  return lines.join('\n');
}

/** The agent's direct chat the wake runs in (the goal's progress messages land there); created when the agent has none yet. */
export async function goalConversationId(store: Store, ownerId: string, agent: Agent): Promise<string> {
  const chats = await listAll(store, 'conversations');
  const found = chats.find((chat) => chat.kind === 'direct' && chat.agentIds.includes(agent.id) && docOwner(chat) === ownerId);
  if (found !== undefined) return found.id;
  const now = new Date().toISOString();
  const created: Conversation & { ownerId: string } = {
    id: 'cvn-' + randomUUID(), kind: 'direct', agentIds: [agent.id], memberIds: [ownerId],
    unreadCount: 0, lastItemAt: now, createdAt: now, ownerId,
  };
  const put = await store.put('conversations', created);
  await store.emit({ type: 'conversation.created', conversation: put });
  return put.id;
}

/** The wake for one goal and reason, or undefined when its agent is gone or belongs to someone else. `key` makes a retry of the same wake a no-op. */
export async function buildGoalWake(store: Store, goal: Goal, reason: CheckinReason, now: Date, key: string): Promise<WakeEvent | undefined> {
  const ownerId = docOwner(goal);
  const agent = await store.get('agents', goal.agentId);
  if (ownerId === undefined || agent === null || docOwner(agent) !== ownerId) return undefined;
  const conversationId = await goalConversationId(store, ownerId, agent);
  // A scheduled check-in is the agent's own decision to message: it gets the owner's proactive rules in the wake text (never the frozen prompt).
  // A manual check, the plan and a deadline reminder are things the owner asked for or set, and run as set.
  const rules = reason === 'scheduled' ? await rulesForWake(store, ownerId, now) : '';
  const text = checkinText(goal, reason, now) + (rules === '' ? '' : '\n\n' + rules + '\n' + harnessText('checkin.rules_note'));
  return {
    id: 'wake_goal_' + reason + '_' + goal.id + '_' + key,
    ownerId,
    agentId: agent.id,
    sessionKey: sessionKey(agent.id, conversationId),
    conversationId,
    kind: 'goal_checkin',
    origin: { type: 'automation', id: goal.id, label: 'Goal: ' + goal.title },
    trusted: true,
    priority: 'background',
    payload: { goalId: goal.id, title: goal.title, reason, text },
    at: now.toISOString(),
    status: 'accepted',
  };
}

/** Hand one goal wake to the enqueuer (plan on create, "Check now"); false when it could not be built or was not accepted. */
export async function queueGoalWake(deps: { store: Store; enqueuer: Enqueuer }, goal: Goal, reason: 'plan' | 'manual', now = new Date()): Promise<boolean> {
  const wake = await buildGoalWake(deps.store, goal, reason, now, reason === 'plan' ? 'once' : String(now.getTime()));
  if (wake === undefined) return false;
  try {
    return (await deps.enqueuer.enqueue(wake)).accepted;
  } catch {
    return false;
  }
}

/**
 * The tick: wakes for this owner's goals that are due. A reminder for a milestone due within 24 hours goes first (and is marked as sent);
 * a scheduled check-in moves its goal's next check a day ahead right away, so a missed or failed run is retried tomorrow, not every hour.
 */
export async function collectDueWakes(store: Store, ownerId: string, now: Date): Promise<WakeEvent[]> {
  const goals = (await listAll(store, 'goals')).filter((goal) => docOwner(goal) === ownerId && goal.status === 'active');
  const wakes: WakeEvent[] = [];
  for (const goal of goals.sort((a, b) => (a.nextCheckAt ?? '').localeCompare(b.nextCheckAt ?? '') || a.id.localeCompare(b.id))) {
    if (wakes.length >= MAX_WAKES_PER_TICK) break;
    const deadlines = dueDeadlines(goal, now);
    const due = isCheckinDue(goal, now);
    if (deadlines.length === 0 && !due) continue;
    const marked = deadlines.length === 0 ? goal : { ...goal, milestones: (goal.milestones ?? []).map((milestone) => (deadlines.includes(milestone) ? { ...milestone, remindedAt: now.toISOString() } : milestone)) };
    const wake = await buildGoalWake(store, goal, deadlines.length > 0 ? 'deadline' : 'scheduled', now, deadlines.length > 0 ? deadlines.map((milestone) => milestone.id).join('+') : (goal.nextCheckAt ?? ''));
    if (wake === undefined) continue;
    const updated = await store.patch('goals', goal.id, {
      ...(deadlines.length > 0 ? { milestones: marked.milestones } : {}),
      ...(due ? { nextCheckAt: clampNextCheck(undefined, now) } : {}),
      lastCheckedAt: now.toISOString(),
    });
    await store.emit({ type: 'goal.updated', goal: updated });
    wakes.push(wake);
  }
  return wakes;
}
