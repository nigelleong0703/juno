/** The model cannot settle a goal-mode run over a pending factual browser contract. */
import type { RunContext, RunInput, RunServices } from './run-types.js';
import type { TodoGate } from './todo-gate.js';

export function withBrowserCompletionGate(gate: TodoGate, ctx: RunContext, services: RunServices, input: RunInput, runId: string): TodoGate {
  let recoveryOffered = false;
  const store = services.store.forOwner?.(input.wakeEvents[0]?.ownerId ?? '') ?? services.store;
  return { ...gate, async settleFinal(key) {
    const pending = await ctx.run('browser-final:' + key, async () =>
      (await store.list('browserGoalGates', { where: { runId, agentId: input.agentId, conversationId: input.conversationId }, limit: 3 })).items.filter(g => g.status !== 'verified'));
    if (!pending.length) return gate.settleFinal(key);
    if (!recoveryOffered && pending.every(g => g.status === 'pending')) {
      recoveryOffered = true;
      await gate.hint('browser:' + key, 'Browser completion conditions remain unverified. Do not claim completion. Inspect and recover the existing stage with its original conditions, or report it as unverified. Pending: ' + JSON.stringify(pending.map(g => ({ goal: g.goal, completion: g.completion, verification: g.verification }))));
      return 'continued';
    }
    await ctx.run('browser-block:' + key, () => services.store.patch('runs', runId, { error: 'browser stage remains unverified: ' + pending.map(g => g.goal).join('; ') }));
    return 'blocked';
  } };
}
