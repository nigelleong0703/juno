/**
 * The daily goal briefing (BACKEND §5.10), after Muse's background jobs that "prepare ideas or goal briefings": once per local day one
 * model call writes one short line per active goal that changed since its last briefing, straight into the goal's timeline (not a chat
 * message). Goals that did not change cost nothing; when none changed there is no call. Pure job logic; the MemoryTimer calls it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appendGoalActivity, type Goal } from '@agent-desktop/public-contracts';
import { readOwnerTimeZone } from '../../execution/brain/context.js';
import { docOwner } from '../../execution/execution-owner.js';
import { harnessText } from '../harness/loader.js';
import { jsonObjectIn } from '../memory/jobs/model-json.js';
import type { JobDeps } from '../memory/jobs/types.js';
import { recordJobUsage } from '../memory/jobs/usage.js';
import { listAll } from '../memory/util.js';
import { briefingDue } from './schedule.js';

/** Timeline lines this job writes start with this, so the next run can tell its own entries from real progress. */
export const BRIEFING_PREFIX = 'Daily briefing: ';
/** The one cap: goals described to the model per run (the rest wait for the next day). */
const MAX_GOALS = 20;

export interface GoalBriefingCheckpoint {
  /** The user's local date it last ran for. */
  date?: string;
  /** What each goal looked like when it was last briefed. */
  hashes?: Record<string, string>;
}

export type GoalBriefingResult = { outcome: 'done' | 'skipped' | 'failed'; checkpoint: GoalBriefingCheckpoint };

const replySchema = z.object({ lines: z.array(z.object({ id: z.string(), text: z.string().trim().min(1).max(300) })) });

const progressOf = (goal: Goal) => (goal.activity ?? []).find((entry) => !entry.text.startsWith(BRIEFING_PREFIX));

/** What counts as a change: the summary, status, plan and the newest real timeline entry; never the briefing lines themselves. */
export function goalFingerprint(goal: Goal): string {
  const latest = progressOf(goal);
  return createHash('sha256').update(JSON.stringify([goal.status, goal.summary, goal.milestones ?? [], latest?.at ?? '', latest?.text ?? ''])).digest('hex').slice(0, 16);
}

function describe(goal: Goal): string {
  const milestones = (goal.milestones ?? []).map((milestone) => '  - [' + milestone.status + '] ' + milestone.title + (milestone.due === undefined ? '' : ' (due ' + milestone.due + ')')).join('\n');
  const latest = progressOf(goal);
  return '[' + goal.id + '] ' + goal.title + '\nSummary: ' + (goal.summary || '(none)') + (milestones.length > 0 ? '\nMilestones:\n' + milestones : '')
    + (latest === undefined ? '' : '\nLatest: ' + latest.at + ' ' + latest.text);
}

export async function runGoalBriefing(deps: JobDeps, input: { ownerId: string; agentId: string; checkpoint: GoalBriefingCheckpoint }): Promise<GoalBriefingResult> {
  const { store, model } = deps;
  const { ownerId, agentId, checkpoint } = input;
  const now = (deps.now ?? (() => new Date()))();
  const timeZone = await readOwnerTimeZone(store, ownerId);
  const day = briefingDue(now, timeZone, checkpoint.date);
  if (!day.due) return { outcome: 'skipped', checkpoint };
  const known = checkpoint.hashes ?? {};
  const active = (await listAll(store, 'goals')).filter((goal) => docOwner(goal) === ownerId && goal.status === 'active');
  const hashes: Record<string, string> = Object.fromEntries(active.map((goal) => [goal.id, known[goal.id] ?? '']));
  const changed = active.filter((goal) => goalFingerprint(goal) !== known[goal.id]).slice(0, MAX_GOALS);
  if (changed.length === 0) return { outcome: 'skipped', checkpoint: { date: day.date, hashes } };

  const startedAt = new Date();
  const reply = await model.complete({ agentId, sessionKey: 'goals:briefing:' + ownerId, system: harnessText('job.briefing.system'), prompt: changed.map(describe).join('\n\n') });
  if (reply === null) return { outcome: 'failed', checkpoint };
  await recordJobUsage(store, { ownerId, agentId, label: 'Goals: daily briefing', reply, startedAt, finishedAt: new Date() });
  const parsed = replySchema.safeParse(jsonObjectIn(reply.text));
  if (!parsed.success) return { outcome: 'failed', checkpoint };

  const at = now.toISOString();
  for (const goal of changed) {
    hashes[goal.id] = goalFingerprint(goal);
    const line = parsed.data.lines.find((candidate) => candidate.id === goal.id);
    if (line === undefined) continue;
    // Re-read: the goal may have moved while the model was thinking. The briefing line is a note and does not touch updatedAt.
    const fresh = await store.get('goals', goal.id);
    if (fresh === null || fresh.status !== 'active') continue;
    const updated = await store.patch('goals', goal.id, { activity: appendGoalActivity(fresh.activity, { at, actor: 'agent', kind: 'note', text: BRIEFING_PREFIX + line.text.replace(/\s+/g, ' ') }) });
    await store.emit({ type: 'goal.updated', goal: updated });
  }
  return { outcome: 'done', checkpoint: { date: day.date, hashes } };
}
