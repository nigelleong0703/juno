/**
 * Self-evolving platform skills: every threshold in one place, and the pure statistics that use them (BACKEND §5.15).
 * Nothing here touches a database. The rules are deliberately asymmetric safety valves, not a hypothesis test: an edit is one line, a
 * wrong edit costs a few bad runs, and the revert is a pointer move.
 */
import { createHash } from 'node:crypto';

/** Share of runs (per skill, decided by a hash of run id and skill id) that read a candidate version instead of the active one. */
export const CANARY_PERCENT = 20;
/** A candidate needs at least this many labelled exposures (a helpful or harmful outcome; unknown does not count) before it can be promoted. */
export const PROMOTE_MIN_LABELED = 40;
/** Rolling back on a clearly worse rate needs at least this many labelled exposures, so three early bad runs cannot kill a candidate. */
export const ROLLBACK_MIN_LABELED = 10;
/** A candidate that neither promoted nor rolled back this long after it was made is retired for lack of data. */
export const CANDIDATE_MAX_AGE_DAYS = 14;
/** After an expiry (not a rollback) the same operations are blocked this long, so a rarely used skill is not re-tried every night. */
export const EXPIRED_TOMBSTONE_DAYS = 30;
/** z of the Wilson interval: 1.96 is 95%. */
export const WILSON_Z = 1.96;

/** Line operations one skill may receive in one night. */
export const MAX_OPS_PER_SKILL_PER_NIGHT = 3;
/** Run ids one operation may cite as its evidence. */
export const MAX_EVIDENCE_PER_OP = 5;
/** A line an operation writes: one line, at most this long. */
export const MAX_OP_LINE_CHARS = 500;
/** An operation may remove or replace at most this share of a skill's non-empty lines (at least one line), so short skills cannot be rewritten by three ops. */
export const MAX_CHANGED_LINE_SHARE = 0.5;

/** Nightly job: a run is labelled once it finished this long ago (the owner-correction window is 30 minutes). */
export const LABEL_SETTLE_MINUTES = 60;
/** Nightly job: a blocked run waits this long for the owner to answer before it counts as abandoned. */
export const BLOCKED_ABANDON_HOURS = 24;
/** Nightly job: runs older than this are no longer labelled (a long outage does not label a month at once). */
export const LABEL_LOOKBACK_DAYS = 3;
/** Nightly job: runs labelled per night, at most. */
export const LABEL_MAX_RUNS_PER_NIGHT = 5000;
/** Reflector: bad runs and good runs one call shows (sampled). */
export const REFLECT_BAD_RUNS = 10;
export const REFLECT_GOOD_RUNS = 3;
/** Reflector: a skill is reflected on only if it had at least this many bad runs in the night's batch. */
export const REFLECT_MIN_BAD_RUNS = 1;
/** Fleet metrics: the window they cover. */
export const METRICS_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Rate {
  /** bad / n (0 when n is 0). */
  rate: number;
  low: number;
  high: number;
  n: number;
}

/** The Wilson score interval of `bad` out of `n`. With no data the interval is the whole range. */
export function wilson(bad: number, n: number, z: number = WILSON_Z): Rate {
  if (n <= 0) return { rate: 0, low: 0, high: 1, n: 0 };
  const p = bad / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { rate: p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin), n };
}

/** Whether this run reads the candidate of this skill. Pure in (run id, skill id): the same run always sees the same version. */
export function canaryServes(runId: string, skillId: string, percent: number = CANARY_PERCENT): boolean {
  const digest = createHash('sha256').update(runId + '\u0000' + skillId).digest();
  return digest.readUInt32BE(0) % 100 < percent;
}

export interface CandidateCounts {
  helpful: number;
  harmful: number;
  createdAtMs: number;
}

export interface ActiveCounts {
  /** The active version's helpful / harmful since the candidate was made (its counters now minus the snapshot). */
  windowHelpful: number;
  windowHarmful: number;
  /** Its lifetime counters, used when the window is empty. */
  helpful: number;
  harmful: number;
}

export type CandidateVerdict = { decision: 'promote' | 'rollback' | 'expire' | 'wait'; reason: string };

/**
 * The verdict on a candidate. Order matters: a clearly worse candidate is rolled back first, then a clearly not-worse one is promoted, then
 * a candidate that ran out of time expires, otherwise it waits.
 * - rollback: labelled >= ROLLBACK_MIN_LABELED and the candidate's Wilson lower bound is above the active's Wilson upper bound.
 * - promote: labelled >= PROMOTE_MIN_LABELED and the candidate's Wilson upper bound is not above the active's point estimate. (The active's
 *   rate is its rate over the canary window, or its lifetime rate when the window is empty; with no active data at all nothing promotes.)
 */
export function judgeCandidate(candidate: CandidateCounts, active: ActiveCounts, nowMs: number, z: number = WILSON_Z): CandidateVerdict {
  const candidateRate = wilson(candidate.harmful, candidate.helpful + candidate.harmful, z);
  const windowN = active.windowHelpful + active.windowHarmful;
  const activeRate = windowN > 0 ? wilson(active.windowHarmful, windowN, z) : wilson(active.harmful, active.helpful + active.harmful, z);
  if (candidateRate.n >= ROLLBACK_MIN_LABELED && activeRate.n > 0 && candidateRate.low > activeRate.high) {
    return { decision: 'rollback', reason: `bad rate lower bound ${pct(candidateRate.low)} is above the active's upper bound ${pct(activeRate.high)} (n=${String(candidateRate.n)})` };
  }
  if (candidateRate.n >= PROMOTE_MIN_LABELED && activeRate.n > 0 && candidateRate.high <= activeRate.rate) {
    return { decision: 'promote', reason: `bad rate upper bound ${pct(candidateRate.high)} is not above the active's rate ${pct(activeRate.rate)} (n=${String(candidateRate.n)})` };
  }
  if (nowMs - candidate.createdAtMs >= CANDIDATE_MAX_AGE_DAYS * DAY_MS) {
    return { decision: 'expire', reason: `no verdict after ${String(CANDIDATE_MAX_AGE_DAYS)} days (labelled exposures: ${String(candidateRate.n)})` };
  }
  return { decision: 'wait', reason: `labelled exposures: ${String(candidateRate.n)}` };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
