/**
 * What the memory jobs (BACKEND §5.4) need from the outside. Nothing here knows about Restate: the harness adapter
 * (`execution/harness/services/memory-timer.ts`) supplies the model call and the clock, keeps the checkpoints and re-runs on schedule.
 */
import type { AssistantTurn } from '../../../contracts/index.js';
import type { HomeDeps } from '../../home/service.js';
import type { MemoryGraph } from '../graph.js';
import type { GoalBriefingCheckpoint } from '../../goals/briefing.js';

export interface ModelReply {
  text: string;
  usage: AssistantTurn['usage'];
  /** The model that answered, for the usage record. */
  model?: string;
}

export interface JobModel {
  /** One tool-less call on the model of the user's default agent; null when there is no usable model or the answer was unusable. */
  complete(input: { agentId: string; sessionKey: string; system: string; prompt: string }): Promise<ModelReply | null>;
}

export interface JobDeps extends HomeDeps {
  model: JobModel;
  now?: () => Date;
  /** The memory items and the identity graph (Postgres); the jobs write items and render the views from them. */
  memory: MemoryGraph;
}

/** What the claim and relation writes need: the store, the graph, the computer's home (the views are written there) and a log. */
export type ClaimDeps = Pick<JobDeps, 'store' | 'memory' | 'home' | 'log'>;

export interface NightlyCheckpoint {
  /** `at` of the newest message the last nightly job had seen. */
  itemsAt?: string;
  /** When it last ran, so a forget since then makes it rewrite the synthesis. */
  at?: string;
  /** The user's local date it last ran for. */
  date?: string;
  /** The newest change to any memory item the last tidy had seen or made: an item changed after it makes the next night tidy again. */
  tidiedAt?: string;
  /**
   * The tidy version that last finished. The first tidy of an owner (none yet) is also the backfill: items without a topic get one and
   * old "User …" wordings are rewritten. It lives here, in the owner's timer state, because a marker row in the owner's home would be
   * synced to their computer; it is set only when the model answered, so a failed backfill is tried again the next night.
   */
  tidyVersion?: number;
}

export interface JobState {
  nightly: NightlyCheckpoint;
  /** The daily goal briefing (BACKEND §5.10); absent in state saved before it existed. */
  goals?: GoalBriefingCheckpoint;
}

export const EMPTY_JOB_STATE: JobState = { nightly: {} };

export type JobOutcome = 'done' | 'skipped' | 'failed';
