/**
 * Goals an agent keeps for its owner (the same rows the goals page edits). The context carries one line
 * per active goal so the agent can follow up; goal_update changes them. A goal is the agent's own:
 * only rows of this owner written for this agent are visible here.
 */
import type { Store } from '../../contracts/index.js';
import type { Goal } from '@agent-desktop/public-contracts';
import { docOwner } from '../../execution/execution-owner.js';
import { listAll } from '../memory/util.js';

/** The one cap: goal lines shown per context build; the rest are counted, not listed. */
const MAX_GOAL_LINES = 50;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The owner's goals of one agent, most recently updated first. */
export async function agentGoals(store: Store, ownerId: string, agentId: string): Promise<Goal[]> {
  const rows = await listAll(store, 'goals');
  return rows
    .filter((row) => docOwner(row) === ownerId && row.agentId === agentId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

function line(goal: Goal): string {
  const steps = goal.steps === undefined || goal.steps.length === 0
    ? ''
    : ' (' + String(goal.steps.filter((step) => step.done).length) + '/' + String(goal.steps.length) + ' steps)';
  const plan = goal.milestones === undefined || goal.milestones.length === 0
    ? ''
    : ' (' + String(goal.milestones.filter((milestone) => milestone.status === 'done').length) + '/' + String(goal.milestones.length) + ' milestones)';
  return '- ' + oneLine(goal.title) + ': ' + oneLine(goal.summary) + steps + plan;
}

/** The system-prompt section: a header and one line per active goal; '' when there are none. */
export function renderGoalSection(goals: Goal[]): string {
  const active = goals.filter((goal) => goal.status === 'active');
  if (active.length === 0) return '';
  const lines = active.slice(0, MAX_GOAL_LINES).map(line);
  const hidden = active.length - MAX_GOAL_LINES;
  if (hidden > 0) lines.push('(' + String(hidden) + ' more not shown)');
  return 'Goals you are working on with the user (recorded in the background after your conversations): use them to pick up where you left off. Mention progress only when the user asks or it bears on their message; never steer the chat toward the next step.\n' + lines.join('\n');
}

/** Section for one agent; '' without a known owner (goals are never shown unowned). */
export async function buildGoalSection(store: Store, agentId: string, ownerId: string | undefined): Promise<string> {
  if (ownerId === undefined) return '';
  return renderGoalSection(await agentGoals(store, ownerId, agentId));
}
