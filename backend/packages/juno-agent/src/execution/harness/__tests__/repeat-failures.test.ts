/**
 * The same call failing again and again (BACKEND §3.3d): the third identical failing attempt is refused with a tool error, the fifth ends the
 * run blocked (`no_progress`). Counting and thresholds are checked on their own; the run-level behaviour goes through the production loop.
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import { afterAttempt, callKey, repeatVerdict } from '../services/repeat-failures.js';
import { call, driveTools, turn } from '../../../testing/drive-tools.js';

const failed = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const ok = { content: [{ type: 'text' as const, text: 'fine' }] };

describe('the identity of a call', () => {
  it('is the tool and its arguments, whatever the key order', () => {
    expect(callKey('lookup', { a: 1, b: { c: 2, d: 3 } })).toBe(callKey('lookup', { b: { d: 3, c: 2 }, a: 1 }));
    expect(callKey('lookup', { a: 1 })).not.toBe(callKey('lookup', { a: 2 }));
    expect(callKey('lookup', { a: 1 })).not.toBe(callKey('other', { a: 1 }));
  });
});

describe('what the count says to do with the next attempt', () => {
  const key = callKey('lookup', { q: 'x' });
  it('runs the first two attempts, refuses the third and fourth with the last error, and stops the run at the fifth', () => {
    let seen = afterAttempt(undefined, key, failed('HTTP 400: bad date'));
    expect(repeatVerdict(seen, key).kind).toBe('run');
    seen = afterAttempt(seen, key, failed('HTTP 400: bad date'));
    const third = repeatVerdict(seen, key);
    expect(third).toEqual({ kind: 'refuse', text: 'This exact call already failed twice with: HTTP 400: bad date. Change the arguments or approach, or stop and say what is blocking.' });
    seen = afterAttempt(seen, key, { ...failed('Error: ' + (third.kind === 'refuse' ? third.text : '')), details: { repeatRefused: true } });
    expect(repeatVerdict(seen, key).kind).toBe('refuse');
    seen = afterAttempt(seen, key, { ...failed('refused again'), details: { repeatRefused: true } });
    expect(repeatVerdict(seen, key).kind).toBe('block');
    expect(seen?.[key]?.error).toBe('HTTP 400: bad date');
  });

  it('counts only errors, and a success or a different call starts over', () => {
    const other = callKey('lookup', { q: 'y' });
    let seen = afterAttempt(undefined, key, ok);
    expect(seen).toBeUndefined();
    seen = afterAttempt(afterAttempt(seen, key, failed('no')), other, failed('no'));
    seen = afterAttempt(seen, key, failed('no'));
    expect(repeatVerdict(seen, key).kind).toBe('refuse');
    expect(repeatVerdict(seen, other).kind).toBe('run');
    seen = afterAttempt(seen, key, ok);
    expect(repeatVerdict(seen, key).kind).toBe('run');
    expect(repeatVerdict(seen, other).kind).toBe('run');
  });
});

function lookupTool(run: (args: unknown) => ReturnType<Tool['execute']>): { tool: Tool; executions: () => number } {
  let executions = 0;
  const tool: Tool = {
    name: 'lookup', description: 'look something up', parameters: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', sideEffect: false,
    async execute(args) { executions += 1; return run(args); },
  };
  return { tool, executions: () => executions };
}

describe('a tool that always fails, called again with the same arguments', () => {
  const same = { q: 'weather' };
  const forever = (n: number) => Array.from({ length: n }, (_, i) => turn('', call('c' + String(i), 'lookup', same)));

  it('runs twice, is refused the third and fourth time, and the fifth attempt blocks the run as no_progress', async () => {
    const { tool, executions } = lookupTool(() => Promise.resolve(failed('HTTP 400: the date is a string')));
    const { outcome, run, steps } = await driveTools([...forever(8), turn('gave up')], [tool]);
    expect(outcome).toBe('blocked');
    expect(executions()).toBe(2);
    expect(run?.blockCause).toBe('no_progress');
    expect(steps).toHaveLength(5);
    const refusals = steps.filter((step) => (step.output?.summary ?? '').includes('already failed twice with: HTTP 400: the date is a string'));
    // The third, fourth and fifth attempts are not executed; the fifth also ends the run.
    expect(refusals).toHaveLength(3);
    expect(run?.error).toContain('failed 4 times in a row');
  });

  it('does not touch a call that succeeds, nor the same tool with other arguments', async () => {
    const { tool, executions } = lookupTool(() => Promise.resolve(ok));
    const turns = [turn('', call('a', 'lookup', { q: 'one' })), turn('', call('b', 'lookup', { q: 'one' })), turn('', call('c', 'lookup', { q: 'one' })), turn('', call('d', 'lookup', { q: 'two' })), turn('done')];
    const { outcome } = await driveTools(turns, [tool]);
    expect(outcome).toBe('completed');
    expect(executions()).toBe(4);
  });

  it('a failure between two different calls does not add up: only the same call counts', async () => {
    const { tool, executions } = lookupTool(() => Promise.resolve(failed('nope')));
    const turns = [turn('', call('a', 'lookup', { q: 'x' })), turn('', call('b', 'lookup', { q: 'y' })), turn('', call('c', 'lookup', { q: 'x' })), turn('', call('d', 'lookup', { q: 'y' })), turn('done')];
    const { outcome } = await driveTools(turns, [tool]);
    expect(outcome).toBe('completed');
    expect(executions()).toBe(4);
  });
});
