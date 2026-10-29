/**
 * QR1: awakeable delivery must be observable. A swallowed failure would let the resolve route
 * report a resolved request that the suspended run never received.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { RunnerEnqueuer } from '../enqueuer.js';
import { RunnerStub } from './runner-stub.js';

describe('awakeable delivery', () => {
  it('hands the value to the runner', async () => {
    const stub = new RunnerStub();
    await new RunnerEnqueuer(stub.asRunner(), createMemoryStore()).resolveAwakeable('awk-1', { action: 'answer' });
    expect(stub.calls).toEqual([{ method: 'resolveAwakeable', opts: { id: 'awk-1', value: { action: 'answer' } } }]);
  });

  it('throws when the runner cannot store the resolve', async () => {
    const stub = new RunnerStub();
    stub.failWith = new Error('database is down');
    await expect(new RunnerEnqueuer(stub.asRunner(), createMemoryStore()).resolveAwakeable('awk-3', { action: 'answer' })).rejects.toThrow(/resolveAwakeable failed.*database is down/);
  });
});
