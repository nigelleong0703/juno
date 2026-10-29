/**
 * Memory jobs spend the user's model budget like any other background work, so each call is recorded as a finished background
 * run of the user's default agent: the usage page and the cost ledger read runs, and this is how the spend shows up there.
 */
import { randomUUID } from 'node:crypto';
import type { Run } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import type { ModelReply } from './types.js';

export async function recordJobUsage(store: Store, input: { ownerId: string; agentId: string; label: string; reply: ModelReply; startedAt: Date; finishedAt: Date }): Promise<void> {
  const { reply } = input;
  const run: Run & { ownerId: string } = {
    id: 'run-memory-' + randomUUID(),
    ownerId: input.ownerId,
    agentId: input.agentId,
    title: input.label,
    status: 'completed',
    kind: 'background',
    triggerLabel: input.label,
    steps: [],
    usage: {
      inputTokens: reply.usage.inputTokens,
      outputTokens: reply.usage.outputTokens,
      ...(reply.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: reply.usage.cacheReadTokens }),
      ...(reply.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: reply.usage.cacheWriteTokens }),
      computeSeconds: Math.max(0, (input.finishedAt.getTime() - input.startedAt.getTime()) / 1000),
      costUsd: reply.usage.costUsd,
      ...(reply.usage.costKnown === undefined ? {} : { costKnown: reply.usage.costKnown }),
      ...(reply.usage.measured === undefined ? {} : { measured: reply.usage.measured }),
      steps: 1,
    },
    ...(reply.model === undefined ? {} : { model: reply.model }),
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    lastActivityAt: input.finishedAt.toISOString(),
  };
  await store.put('runs', run);
}
