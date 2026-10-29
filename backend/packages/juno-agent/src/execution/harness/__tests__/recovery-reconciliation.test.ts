import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Doc, ToolContext, ToolResult } from '../../../contracts/index.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runFencedTool, type ToolRunContext } from '../services/replay.js';
import { findPriorUnresolvedFence } from '../services/run-tools.js';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';

const OWNER = 'recovery-owner';
const AGENT = 'recovery-agent';
const CONVERSATION = 'recovery-conversation';
const RUN = 'recovery-run';
const AT = '2026-10-29T00:00:00.000Z';

function context(store: ReturnType<typeof createMemoryStore>, stepId: string, ownerId = OWNER): ToolContext {
  return {
    ownerId, agentId: AGENT, conversationId: CONVERSATION, runId: RUN, stepId,
    store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), signal: new AbortController().signal,
    wake: { id: 'wake-recovery', ownerId, agentId: AGENT, sessionKey: `${AGENT}:${CONVERSATION}`, conversationId: CONVERSATION, kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'start' }, at: AT, status: 'accepted' },
    step: async (_name, action) => action(),
  };
}

function runContext(): ToolRunContext {
  const journal = new Map<string, unknown>();
  return {
    rand: { uuidv4: () => 'recovery-test' },
    run<T>(key: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(key)) return RestatePromise.resolve(structuredClone(journal.get(key)) as T);
      return RestatePromise.resolve(action().then((result) => { journal.set(key, structuredClone(result)); return result; }));
    },
  };
}

function step(id: string): Doc<'steps'> {
  return { id, runId: RUN, index: 0, kind: 'mcp', tool: 'send_message', verb: 'Sent', target: 'hello', status: 'running', startedAt: AT, durationMs: 0 };
}

const intent = { ownerId: OWNER, agentId: AGENT, tool: 'send_message', fingerprint: 'a'.repeat(64) };

describe('fenced external action reconciliation', () => {
  it('recovers the production send_message result from its exact owner-scoped local receipt without resending', async () => {
    const store = createMemoryStore();
    const tool = createSendMessageTool({ store, enqueuer: new NoopEnqueuer() });
    const row = step('stp-message-receipt');
    await store.put('steps', row, { runId: RUN });
    const toolCtx = context(store, row.id);
    let sends = 0;
    const action = async (): Promise<ToolResult> => { sends += 1; return tool.execute({ kind: 'text', text: 'hello' }, toolCtx); };
    const first = await runFencedTool(runContext(), store, row, tool.name, action, NEVER_CANCELLED, () => tool.reconcile!({ kind: 'text', text: 'hello' }, toolCtx), intent);
    expect(first.interrupted).toBe(false);
    expect(sends).toBe(1);
    await store.put('steps', Object.assign(row, { execution: { fencedAt: AT, intent } }), { runId: RUN });

    const recovered = await runFencedTool(runContext(), store, row, tool.name, action, NEVER_CANCELLED, () => tool.reconcile!({ kind: 'text', text: 'hello' }, toolCtx), intent);
    expect(recovered.interrupted).toBe(false);
    expect(recovered.reconciliation?.status).toBe('succeeded');
    expect(recovered.result.details).toMatchObject({ deliveredText: 'hello', deliveredConversationId: CONVERSATION });
    expect(sends).toBe(1);
  });

  it('requires a separate attempt fence after the production adapter proves the original receipt absent', async () => {
    const store = createMemoryStore();
    const tool = createSendMessageTool({ store, enqueuer: new NoopEnqueuer() });
    const row = step('stp-message-not-sent');
    await store.put('steps', Object.assign(row, { execution: { fencedAt: AT, intent } }), { runId: RUN });
    const toolCtx = context(store, row.id);
    let sends = 0;
    const outcome = await runFencedTool(runContext(), store, row, tool.name, async () => {
      sends += 1;
      return tool.execute({ kind: 'text', text: 'hello' }, toolCtx);
    }, NEVER_CANCELLED, () => tool.reconcile!({ kind: 'text', text: 'hello' }, toolCtx), intent);
    expect(outcome.interrupted).toBe(true);
    expect(outcome.reconciliation?.status).toBe('not_executed');
    expect(sends).toBe(0);
    expect(JSON.stringify(await store.get('steps', row.id))).toContain('"status":"not_executed"');
  });

  it('runs a retry only under its independently persisted attempt fence and rechecks the receipt on recovery', async () => {
    const store = createMemoryStore();
    const tool = createSendMessageTool({ store, enqueuer: new NoopEnqueuer() });
    const row = step('stp-message-retry-attempt');
    const attemptIntent = { ...intent, attempt: 1 };
    await store.put('steps', Object.assign(row, { execution: { fencedAt: AT, intent: attemptIntent } }), { runId: RUN });
    const toolCtx = context(store, row.id);
    let sends = 0;
    const action = async (): Promise<ToolResult> => { sends += 1; return tool.execute({ kind: 'text', text: 'hello' }, toolCtx); };
    const resumed = await runFencedTool(runContext(), store, row, tool.name, action, NEVER_CANCELLED, () => tool.reconcile!({ kind: 'text', text: 'hello' }, toolCtx), attemptIntent);
    expect(resumed.interrupted).toBe(false);
    expect(resumed.reconciliation?.status).toBe('not_executed');
    expect(sends).toBe(1);
    expect((await tool.reconcile!({ kind: 'text', text: 'hello' }, toolCtx)).status).toBe('succeeded');
  });

  it('keeps unsupported routes and changed owner/arguments unknown without invoking the effect', async () => {
    const store = createMemoryStore();
    const tool = createSendMessageTool({ store, enqueuer: new NoopEnqueuer() });
    const row = step('stp-message-other-owner');
    await store.put('steps', Object.assign(row, { execution: { fencedAt: AT, intent } }), { runId: RUN });
    const wrongOwner = context(store, row.id, 'other-owner');
    let executions = 0;
    const changed = await runFencedTool(runContext(), store, row, tool.name, async () => {
      executions += 1;
      return { content: [{ type: 'text', text: 'should not run' }] };
    }, NEVER_CANCELLED, () => tool.reconcile!({ kind: 'text', text: 'hello' }, wrongOwner), { ...intent, ownerId: 'other-owner' });
    expect(changed.interrupted).toBe(true);
    expect(executions).toBe(0);

    const unsupported = await tool.reconcile!({ kind: 'text', text: 'hello', toOwner: true }, context(store, row.id));
    expect(unsupported.status).toBe('unknown');
  });

  it('never treats timeout or external errors as proof that a write did not execute', async () => {
    const store = createMemoryStore();
    const row = step('stp-message-timeout');
    await store.put('steps', row, { runId: RUN });
    const outcome = await runFencedTool(runContext(), store, row, 'send_message', async () => ({
      content: [{ type: 'text', text: 'Timed out after submitting the message.' }],
      isError: true,
      details: { errorKind: 'timeout' },
    }), NEVER_CANCELLED, undefined, intent);
    expect(outcome.interrupted).toBe(true);
    expect(outcome.reconciliation?.status).toBe('unknown');
    expect((await store.get('steps', row.id))).toMatchObject({ execution: { reconciliation: { status: 'unknown' } } });
    expect(JSON.stringify(await store.get('steps', row.id))).not.toContain('"result":{');
  });

  it('finds a previous run fence with no result only for the same owner, conversation, account and arguments', async () => {
    const store = createMemoryStore();
    await store.put('runs', {
      id: 'recovery-prior-run', agentId: AGENT, conversationId: CONVERSATION, title: 'prior', status: 'stopped', kind: 'chat',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
    });
    const prior = { ...step('stp-prior-run-fenced'), runId: 'recovery-prior-run' };
    await store.put('steps', Object.assign(prior, { execution: {
      fencedAt: AT,
      intent: { ...intent, conversationId: CONVERSATION, account: 'account-a' },
    } }), { runId: prior.runId });

    const found = await findPriorUnresolvedFence(store, AGENT, 'stp-current-run', intent.fingerprint, OWNER, 'send_message', CONVERSATION, undefined, 'account-a');
    const wrongAccount = await findPriorUnresolvedFence(store, AGENT, 'stp-current-run', intent.fingerprint, OWNER, 'send_message', CONVERSATION, undefined, 'account-b');

    expect(found?.id).toBe(prior.id);
    expect(wrongAccount).toBeUndefined();
  });
});
