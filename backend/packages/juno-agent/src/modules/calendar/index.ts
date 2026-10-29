// The agent's OWN calendar (BACKEND "Agent 自己的日历"): one-off follow-ups, meetings and tasks it keeps for itself.
// Pure helpers over the `agentCalendar` collection: the wake that fires when an item is due, and the short
// "Your calendar" line a run is told. The timer that wakes it is execution/harness/services/calendar-timer.ts.
import type { AgentCalendarItem } from '@agent-desktop/public-contracts';
import { sessionKey, type Store, type WakeEvent } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { goalConversationId } from '../goals/checkin.js';

/** A wake later than this after the item's time counts as missed (the engine or app was off). */
export const CALENDAR_GRACE_MS = 15 * 60_000;
const LINE_ITEMS = 5;
const LINE_DAYS = 7;

/** One agent's items in time order (one indexed page of 200). */
export async function agentCalendarItems(store: Store, agentId: string, status?: AgentCalendarItem['status']): Promise<AgentCalendarItem[]> {
  const page = await store.list('agentCalendar', { where: { agentId, ...(status === undefined ? {} : { status }) }, limit: 200, orderBy: 'at', order: 'asc' });
  return page.items;
}

export function formatCalendarTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) + ` (${timezone})`;
  } catch {
    return iso;
  }
}

/** "Your calendar: Tue Oct 21, 15:00 follow_up "Ask Sam about the quote"; ..." for the next few items, or '' when there are none. */
export async function calendarLine(store: Store, agentId: string, now: Date, zone: string | undefined): Promise<string> {
  const until = now.getTime() + LINE_DAYS * 86_400_000;
  const items = (await agentCalendarItems(store, agentId, 'scheduled')).filter((item) => Date.parse(item.at) <= until).slice(0, LINE_ITEMS);
  if (items.length === 0) return '';
  const where = zone ?? 'UTC';
  return 'Your schedule (next 7 days): ' + items.map((item) => `${formatCalendarTime(item.at, where)} ${item.kind} "${item.title.slice(0, 80)}" [${item.id}]`).join('; ') + '.';
}

/** What the agent reads when an item is due (or missed). */
export function calendarWakeText(item: AgentCalendarItem, missed: boolean, now: Date): string {
  const lines = [
    missed
      ? `Your schedule item "${item.title}" (${item.kind}, id ${item.id}) was due ${formatCalendarTime(item.at, item.timezone)} but could not run then (it is ${now.toISOString()} now). Decide whether it is still worth doing, do it if so, or tell the user it was missed.`
      : `Your schedule item "${item.title}" (${item.kind}, id ${item.id}) is due now (${formatCalendarTime(item.at, item.timezone)}). You set it for yourself.`,
    `What to do: ${item.instructions}`,
  ];
  if (item.withWhom !== undefined) lines.push(`With: ${item.withWhom.name}${item.withWhom.channel === undefined ? '' : ` (${item.withWhom.channel.kind}: ${item.withWhom.channel.target})`}`);
  if (item.meeting !== undefined) lines.push(`Meeting: ${item.meeting.platform}${item.meeting.channelId === undefined ? '' : ` channel ${item.meeting.channelId}`}${item.meeting.url === undefined ? '' : ` ${item.meeting.url}`}`);
  lines.push('Anything you send to a third party still follows the usual approval rules. When finished, record how it went with schedule_update (result).');
  return lines.join('\n');
}

/** The wake for one due item, or undefined when its agent is gone. It runs in the item's chat, else the agent's direct chat. */
export async function buildCalendarWake(store: Store, item: AgentCalendarItem, now: Date, missed: boolean): Promise<WakeEvent | undefined> {
  const ownerId = docOwner(item);
  const agent = await store.get('agents', item.agentId);
  if (ownerId === undefined || agent === null || docOwner(agent) !== ownerId) return undefined;
  const chat = item.conversationId === undefined ? null : await store.get('conversations', item.conversationId);
  const conversationId = chat !== null && chat.agentIds.includes(agent.id) ? chat.id : await goalConversationId(store, ownerId, agent);
  return {
    id: `wake_calendar_${item.id}_${Date.parse(item.at)}`,
    ownerId,
    agentId: agent.id,
    sessionKey: sessionKey(agent.id, conversationId),
    conversationId,
    kind: 'calendar_due',
    origin: { type: 'system', id: item.id, label: 'Calendar: ' + item.title },
    trusted: true,
    priority: 'background',
    payload: { itemId: item.id, title: item.title, missed, text: calendarWakeText(item, missed, now) },
    at: now.toISOString(),
    status: 'accepted',
  };
}
