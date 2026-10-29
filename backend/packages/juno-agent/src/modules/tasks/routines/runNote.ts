/**
 * The wake text of a scheduled routine run (BACKEND §3.6, §10.10): the routine's own instructions, a compact run context and
 * the Feed posting guidance. Built fresh for each fire, so the agent knows what is true now (date, connected apps, tools) and
 * what it already did (its recent posts, the owner's feedback) instead of guessing. Fixed wording plus data.
 */
import type { Routine } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { docOwner } from '../../../execution/execution-owner.js';
import { listAll } from '../../memory/util.js';
import { agentAppSettings, usableApps } from '../../apps/agent-apps.js';
import { FEED_DEDUPE_DAYS, feedbackAdvice, feedbackLine, localLabel, oneLine, ownerTimeZone, recentFeedback, recentRoutinePosts } from '../../feed/context.js';
import { postingGuidance } from '../../feed/postingGuidance.js';

/** What the platform offers every agent run; decided at boot from the registered tools. */
export interface RunCapabilities {
  webSearch: boolean;
  computer: boolean;
}

const NOTE_POSTS_MAX = 10;
const APPS_MAX = 12;

/** The apps this agent can use (added, signed in, turned on for it), by the name the owner sees ("Gmail", "Google Calendar"). */
async function connectedApps(store: Store, ownerId: string, agentId: string): Promise<string[]> {
  const agent = await store.get('agents', agentId);
  const plugins = new Set(agent?.pluginIds ?? []);
  const connections = (await listAll(store, 'connections')).filter((c) => docOwner(c) === ownerId && (c.pluginId === undefined || plugins.has(c.pluginId)));
  return [...new Set([...usableApps(connections, await agentAppSettings(store, agentId)).values()].map(oneLine))].slice(0, APPS_MAX);
}

const yesNo = (on: boolean): string => (on ? 'available' : 'not available');

/** The compact run context: clock, apps, tools, this routine's recent posts and the owner's feedback. */
export async function routineRunContext(store: Store, routine: Routine, ownerId: string, now: Date, caps: RunCapabilities): Promise<string> {
  const tz = await ownerTimeZone(store, ownerId);
  const apps = await connectedApps(store, ownerId, routine.agentId);
  const posts = (await recentRoutinePosts(store, ownerId, routine.id, now)).slice(0, NOTE_POSTS_MAX);
  const feedback = await recentFeedback(store, ownerId, routine.agentId);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const lines = [
    '[Run context]',
    `Now: ${localLabel(now, tz)}.`,
    `Connected apps: ${apps.length === 0 ? 'none' : apps.join(', ')}.`,
    `Web search: ${yesNo(caps.webSearch)}. Computer and browser: ${yesNo(caps.computer)}.`,
    posts.length === 0
      ? `Your posts from this routine in the last ${String(FEED_DEDUPE_DAYS)} days: none.`
      : `Your posts from this routine in the last ${String(FEED_DEDUPE_DAYS)} days (newest first; do not repeat these stories or links):\n` + posts.map((post) => `- ${day.format(new Date(post.createdAt))}: ${oneLine(post.title)}${post.sourceUrl === undefined ? '' : ' <' + post.sourceUrl + '>'}`).join('\n'),
  ];
  if (feedback.length > 0) {
    lines.push('What the user said about your earlier posts:\n' + feedback.map((post) => `- ${feedbackLine(post)}`).join('\n'));
    const advice = feedbackAdvice(feedback);
    if (advice !== '') lines.push(advice);
  }
  return lines.join('\n');
}

/** The text a scheduled fire wakes the agent with. */
export async function routineRunText(store: Store, routine: Routine, ownerId: string, now: Date, caps: RunCapabilities): Promise<string> {
  const task = routine.instructions.trim() === '' ? routine.name : routine.instructions.trim();
  return [`Routine "${oneLine(routine.name)}": ${task}`, await routineRunContext(store, routine, ownerId, now, caps), postingGuidance()].join('\n\n');
}
