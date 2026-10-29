/**
 * The canary split and the promote / rollback / expire verdicts (BACKEND §5.15), pure code. The thresholds are the named constants of evolve.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  CANARY_PERCENT, CANDIDATE_MAX_AGE_DAYS, PROMOTE_MIN_LABELED, ROLLBACK_MIN_LABELED, canaryServes, judgeCandidate, wilson,
} from '../index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-01T00:00:00Z');

describe('wilson', () => {
  it('gives the whole range with no data and a narrow one with a lot', () => {
    expect(wilson(0, 0)).toMatchObject({ rate: 0, low: 0, high: 1, n: 0 });
    const w = wilson(10, 100);
    expect(w.rate).toBeCloseTo(0.1);
    expect(w.low).toBeCloseTo(0.0552, 3);
    expect(w.high).toBeCloseTo(0.1744, 3);
  });

  it('stays inside 0..1 at the extremes', () => {
    expect(wilson(0, 40).low).toBe(0);
    expect(wilson(0, 40).high).toBeGreaterThan(0.08);
    expect(wilson(40, 40).high).toBe(1);
  });
});

describe('canary split', () => {
  it('is deterministic by run id and skill id', () => {
    for (let n = 0; n < 50; n += 1) expect(canaryServes('run_' + String(n), 'pdf')).toBe(canaryServes('run_' + String(n), 'pdf'));
  });

  it('serves about CANARY_PERCENT of runs and varies by skill', () => {
    const runs = Array.from({ length: 5000 }, (_, n) => 'run_' + String(n));
    const share = runs.filter((id) => canaryServes(id, 'pdf')).length / runs.length;
    expect(share).toBeGreaterThan(CANARY_PERCENT / 100 - 0.03);
    expect(share).toBeLessThan(CANARY_PERCENT / 100 + 0.03);
    expect(runs.filter((id) => canaryServes(id, 'pdf') !== canaryServes(id, 'docx')).length).toBeGreaterThan(0);
  });
});

describe('judgeCandidate', () => {
  // The active version: 200 labelled exposures in the window, 30 bad (15%).
  const active = { windowHelpful: 170, windowHarmful: 30, helpful: 400, harmful: 80 };
  const fresh = (helpful: number, harmful: number, ageDays = 1) => ({ helpful, harmful, createdAtMs: NOW - ageDays * DAY });

  it('waits while there is too little data', () => {
    expect(judgeCandidate(fresh(20, 3), active, NOW).decision).toBe('wait');
  });

  it('promotes when enough exposures and the upper bound is not above the active rate', () => {
    // 50 labelled, 2 bad: upper bound about 13.5% < 15%.
    const verdict = judgeCandidate(fresh(48, 2), active, NOW);
    expect(PROMOTE_MIN_LABELED).toBe(40);
    expect(verdict.decision).toBe('promote');
  });

  it('does not promote at the same rate with the bound above the active rate', () => {
    // 40 labelled, 6 bad (15%): the upper bound is far above 15%.
    expect(judgeCandidate(fresh(34, 6), active, NOW).decision).toBe('wait');
  });

  it('does not promote below the minimum, however good the rate', () => {
    expect(judgeCandidate(fresh(PROMOTE_MIN_LABELED - 1, 0), active, NOW).decision).toBe('wait');
  });

  it('rolls back when the lower bound is above the active upper bound', () => {
    // 20 labelled, 14 bad (70%): lower bound about 48% > the active's upper bound (about 20%).
    const verdict = judgeCandidate(fresh(6, 14), active, NOW);
    expect(verdict.decision).toBe('rollback');
    expect(verdict.reason).toMatch(/lower bound/);
  });

  it('does not roll back on a few early bad runs', () => {
    expect(judgeCandidate(fresh(0, ROLLBACK_MIN_LABELED - 1), active, NOW).decision).toBe('wait');
  });

  it('uses the active lifetime rate when its window is empty, and never decides with no active data at all', () => {
    const noWindow = { windowHelpful: 0, windowHarmful: 0, helpful: 400, harmful: 80 };
    expect(judgeCandidate(fresh(48, 2), noWindow, NOW).decision).toBe('promote');
    const none = { windowHelpful: 0, windowHarmful: 0, helpful: 0, harmful: 0 };
    expect(judgeCandidate(fresh(48, 2), none, NOW).decision).toBe('wait');
    expect(judgeCandidate(fresh(0, 20), none, NOW).decision).toBe('wait');
  });

  it('expires after the maximum age without a verdict, and a verdict beats the age', () => {
    expect(judgeCandidate(fresh(5, 1, CANDIDATE_MAX_AGE_DAYS - 1), active, NOW).decision).toBe('wait');
    expect(judgeCandidate(fresh(5, 1, CANDIDATE_MAX_AGE_DAYS), active, NOW).decision).toBe('expire');
    expect(judgeCandidate(fresh(6, 14, CANDIDATE_MAX_AGE_DAYS + 3), active, NOW).decision).toBe('rollback');
  });
});
