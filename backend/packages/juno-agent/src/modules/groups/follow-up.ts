/**
 * Follow-ups of a group's open loops (BACKEND 6.7). When the chat digest reads a group it also says, for the loops it saw come up, when
 * it is worth looking again (a deadline, a promise to come back). Each becomes a one-off item in the agent's own schedule, in the thread
 * the loop came up in, so the agent is woken there at that time with the wake `wake.loop_follow_up` and decides whether to nudge, report
 * or stay silent. This is the schedule the agent already has (`schedule_add`), only filled by the digest as well as by the agent; the
 * model chooses the times, nothing here limits how often the agent speaks.
 */
import { createHash } from 'node:crypto';
import type { AgentCalendarItem } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { harnessText } from '../harness/loader.js';
import { agentCalendarItems } from '../calendar/index.js';
import { MAX_OPEN } from '../tools/tools/calendarTools.js';
import { plainBlock } from './note.js';

/** At most this many follow-ups (counted after the unusable ones are skipped) come out of one digest, none sooner than 5 minutes or later than 30 days from now. */
const PER_DIGEST = 3;
const MIN_AHEAD_MS = 5 * 60_000;
const HORIZON_MS = 30 * 24 * 60 * 60_000;

/** What a scheduled item looks like to the agent: the wake text unit, the title prefix and the id prefix (the id is the dedupe key). */
export interface FollowUpKind { wake: 'wake.loop_follow_up' | 'wake.reminder'; titlePrefix: string; idPrefix: string }
const LOOP_KIND: FollowUpKind = { wake: 'wake.loop_follow_up', titlePrefix: 'Follow up: ', idPrefix: 'cal-loop-' };
/** A direct chat's reminder: the owner's dated event, or something the assistant promised to do later (the digest names both). */
export const REMINDER_KIND: FollowUpKind = { wake: 'wake.reminder', titlePrefix: 'Reminder: ', idPrefix: 'cal-rem-' };

export interface LoopFollowUp {
  /** When to look again, an ISO time with its offset. */
  at: string;
  /** The loop in a line: who, what, by when. */
  about: string;
}

/** Adds the follow-ups to the agent's schedule for this chat; returns how many were new. An item already made for the same loop is not made twice. */
export async function scheduleLoopFollowUps(
  deps: { store: Store; scheduleCalendarItem?: (itemId: string) => Promise<void> },
  input: { ownerId: string; agentId: string; conversationId: string; timezone: string; now: Date; followUps: readonly LoopFollowUp[]; kind?: FollowUpKind },
): Promise<number> {
  const kind = input.kind ?? LOOP_KIND;
  let made = 0;
  let open = (await agentCalendarItems(deps.store, input.agentId, 'scheduled')).length;
  for (const followUp of input.followUps) {
    if (made >= PER_DIGEST) break;
    const at = Date.parse(followUp.at);
    const about = plainBlock(followUp.about.replace(/\s+/g, ' '), 240);
    if (about === '' || !Number.isFinite(at) || at < input.now.getTime() + MIN_AHEAD_MS || at > input.now.getTime() + HORIZON_MS || open >= MAX_OPEN) continue;
    const id = kind.idPrefix + createHash('sha256').update(input.conversationId + '|' + about.toLowerCase()).digest('hex').slice(0, 20);
    if ((await deps.store.get('agentCalendar', id)) !== null) continue;
    const now = input.now.toISOString();
    const item: AgentCalendarItem = {
      id, agentId: input.agentId, ownerId: input.ownerId, kind: 'follow_up', title: (kind.titlePrefix + about).slice(0, 200), at: new Date(at).toISOString(),
      timezone: input.timezone, instructions: harnessText(kind.wake, { about }), conversationId: input.conversationId,
      status: 'scheduled', createdAt: now, updatedAt: now,
    };
    const put = await deps.store.put('agentCalendar', item);
    await deps.scheduleCalendarItem?.(put.id);
    made += 1;
    open += 1;
  }
  return made;
}
