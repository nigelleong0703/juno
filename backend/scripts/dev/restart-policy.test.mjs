import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RESTART_FIRST_MS, RESTART_MAX_MS, RESTART_RESET_UP_MS, restartDelayMs } from './restart-policy.mjs';

/** The waits of a service that keeps crashing right after each start: each restart's wait feeds the next. */
function crashWaits(count, upMs = 0) {
  const waits = [];
  let lastDelayMs;
  for (let index = 0; index < count; index += 1) {
    lastDelayMs = restartDelayMs({ lastDelayMs, upMs });
    waits.push(lastDelayMs);
  }
  return waits;
}

describe('restartDelayMs', () => {
  it('starts at 5 s, doubles, and stays at 60 s', () => {
    assert.deepEqual(crashWaits(6), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    assert.equal(RESTART_FIRST_MS, 5_000);
    assert.equal(RESTART_MAX_MS, 60_000);
  });

  it('starts over at 5 s after a service stayed up more than 2 minutes', () => {
    assert.deepEqual(crashWaits(4), [5_000, 10_000, 20_000, 40_000]);
    assert.equal(restartDelayMs({ lastDelayMs: 40_000, upMs: RESTART_RESET_UP_MS + 1 }), 5_000);
  });

  it('does not reset at exactly 2 minutes of uptime', () => {
    assert.equal(restartDelayMs({ lastDelayMs: 40_000, upMs: RESTART_RESET_UP_MS }), 60_000);
  });

  it('gives the first restart of a service that has not restarted before 5 s', () => {
    assert.equal(restartDelayMs({ upMs: 0 }), 5_000);
  });
});
