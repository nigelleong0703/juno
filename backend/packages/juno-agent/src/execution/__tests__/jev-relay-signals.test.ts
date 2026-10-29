import { describe, expect, it } from 'vitest';
import { addJevRelaySignal, getJevRelaySignal, removeJevRelaySignal } from '../jev-relay-signals.js';

describe('overlapping Jev calls in one run', () => {
  it('retains run cancellation until every call sharing that signal has finished', () => {
    const run = new AbortController();
    addJevRelaySignal('shared-run-owner', 'agent', run.signal);
    addJevRelaySignal('shared-run-owner', 'agent', run.signal);
    removeJevRelaySignal('shared-run-owner', 'agent', run.signal);
    const pending = getJevRelaySignal('shared-run-owner', 'agent');
    expect(pending).toBe(run.signal);
    run.abort();
    expect(pending?.aborted).toBe(true);
    removeJevRelaySignal('shared-run-owner', 'agent', run.signal);
    expect(getJevRelaySignal('shared-run-owner', 'agent')).toBeUndefined();
  });
});
