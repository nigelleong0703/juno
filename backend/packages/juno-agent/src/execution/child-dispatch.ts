/**
 * The production child-run dispatcher (PH12).
 *
 * It is the execution-owner-qualified seam between a tool's admission and the core's Run workflow: it
 * re-reads the RESERVED child row and refuses anything that is not that row's canonical child session,
 * then starts the exact reserved run id through the enqueuer (workflow key = idempotency key). With no
 * enqueuer support it fails closed — a child is never reported started without a real run behind it.
 */
import type { Enqueuer, Store } from '../contracts/index.js';
import { childSessionKey, type ChildDispatchAdapter, type ChildRun } from '../modules/tasks/child.js';
import { docOwner } from './execution-owner.js';

export interface ChildDispatchOptions {
  store: Store;
  enqueuer: Enqueuer;
}

export function createChildDispatchAdapter(options: ChildDispatchOptions): ChildDispatchAdapter {
  return {
    async startChildRun(input) {
      const start = options.enqueuer.startChildRun?.bind(options.enqueuer);
      if (start === undefined) {
        throw new Error('child tasks are unavailable: this deployment cannot start a child run');
      }
      // Execution-owner scope: the reserved row must exist, belong to this parent, and match exactly.
      const row: ChildRun | null = await options.store.get('runs', input.runId);
      if (row === null || row.parentRunId !== input.parentRunId) {
        throw new Error('child run ' + input.runId + ' is not reserved for parent ' + input.parentRunId);
      }
      if (row.agentId !== input.agentId || row.conversationId !== input.conversationId) {
        throw new Error('child run ' + input.runId + ' does not belong to this agent and conversation');
      }
      // Only the canonical child session is accepted; nothing else may be started for this row.
      if (input.sessionKey !== childSessionKey(input.agentId, input.conversationId, input.runId) || row.childSessionKey !== input.sessionKey) {
        throw new Error('child run ' + input.runId + ' may only start on its canonical child session');
      }
      if (input.planId !== row.planId) {
        throw new Error('child run ' + input.runId + ' plan does not match the reserved child plan');
      }
      if (docOwner(row) !== input.ownerId) {
        throw new Error('child run ' + input.runId + ' does not belong to this owner');
      }
      const parent = await options.store.get('runs', input.parentRunId);
      if (parent === null || parent.conversationId !== input.conversationId) {
        throw new Error('child run ' + input.runId + ' parent conversation does not match');
      }
      const conversation = await options.store.get('conversations', input.conversationId);
      if (conversation === null || !conversation.agentIds.includes(input.agentId)) {
        throw new Error('child run ' + input.runId + ' target is not a member of the conversation');
      }
      await start(input);
    },
  };
}
