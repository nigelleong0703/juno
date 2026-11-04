import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { createAccount, defaultAgent, execStack, queryStack, restartAgentd, scriptModel, scriptedChat, toolCall, waitForTranscript } from '../harness/client';
import { setupConnector, uncertainConnector } from '../harness/mcp-fixture';

/** A follow-up user message through the standard run entrypoint (the old `/messages` route no longer exists). */
function sendFollowUp(account: Awaited<ReturnType<typeof createAccount>>, conversationId: string, text: string) {
  const path = `/v1/conversations/${conversationId}/runs`;
  return account.api('POST', path, aguiInput(path, { text }));
}

async function persistedFence(conversationId: string): Promise<{ id: string; runId: string; execution: { fencedAt?: string; intent?: { fingerprint?: string; attempt?: number } } }> {
  const rows = await queryStack("SELECT s.run_id, s.doc FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.doc->>'conversationId' = ? AND s.doc->>'target' = 'Tracker · Create issue' ORDER BY s.created_at LIMIT 1", [conversationId]);
  const step = rows[0]?.['doc'] as { id: string; execution?: { fencedAt?: string; intent?: { fingerprint?: string } } } | undefined;
  expect(step?.execution?.fencedAt, `step execution metadata: ${JSON.stringify(step)}`).toBeTruthy();
  expect(step?.execution?.intent?.fingerprint, `step execution metadata: ${JSON.stringify(step)}`).toMatch(/^[a-f0-9]{64}$/);
  return { ...(step as { id: string; execution: { fencedAt?: string; intent?: { fingerprint?: string; attempt?: number } } }), runId: String(rows[0]?.['run_id']) };
}

/** The questions the person was asked in this agent's chats, through the owner API. */
async function askedRequests(account: Awaited<ReturnType<typeof createAccount>>, agentId: string): Promise<Array<{ id: string; title: string; status: string; payload: unknown }>> {
  const response = await account.api('GET', `/v1/requests?agentId=${encodeURIComponent(agentId)}&kind=question`);
  return (response.body.items ?? []) as Array<{ id: string; title: string; status: string; payload: unknown }>;
}

async function waitForRunCompleted(runId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await queryStack("SELECT doc->>'status' AS status FROM runs WHERE id = ?", [runId]);
    if (rows[0]?.['status'] === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`chat run ${runId} did not complete`);
}

async function waitForNewCompletedConversationRun(conversationId: string, previousRunId: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await queryStack("SELECT id, doc->>'status' AS status FROM runs WHERE conversation_id = ? AND kind = 'chat' AND created_at > (SELECT created_at FROM runs WHERE id = ?) ORDER BY created_at DESC LIMIT 1", [conversationId, previousRunId]);
    const row = rows[0];
    if (row?.['status'] === 'completed' && typeof row['id'] === 'string') return row['id'];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const runs = await queryStack("SELECT id, kind, doc->>'status' AS status, doc->>'error' AS error FROM runs WHERE conversation_id = ? ORDER BY created_at", [conversationId]);
  throw new Error(`no separate completed chat run followed ${previousRunId}; runs: ${JSON.stringify(runs)}`);
}

describe('production PostgreSQL recovery reconciliation after SIGKILL', () => {
  it('reuses a persisted production send_message receipt after restart without posting it twice', async () => {
    const account = await createAccount('recovery-receipt');
    const agent = await defaultAgent(account);
    const marker = `Receipt-${randomUUID()}`;
    const firstText = 'Post this message once.';
    const first = await scriptedChat(account, agent.id, [
      { matchLastText: firstText, step: 0, toolCalls: [toolCall('post-receipt', 'send_message', { kind: 'text', purpose: 'result', text: marker })] },
      { matchLastText: firstText, step: 1, text: 'The message is posted.' },
    ], firstText);
    await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes(marker)));
    const rows = await queryStack("SELECT s.run_id, s.id, s.doc FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.doc->>'conversationId' = ? AND s.doc->>'target' = 'send_message' ORDER BY s.created_at LIMIT 1", [first.conversationId]);
    const original = rows[0]?.['doc'] as { id: string; execution?: { fencedAt?: string; intent?: { fingerprint?: string }; result?: unknown } } | undefined;
    if (original === undefined) throw new Error('expected the persisted send_message action step');
    const originalRunId = String(rows[0]?.['run_id']);
    expect(original?.execution?.fencedAt).toBeTruthy();
    expect(original?.execution?.intent?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(original?.execution?.result).toBeDefined();
    const receipt = await queryStack("SELECT count(*) AS count FROM items WHERE doc->>'markdown' = ? AND doc->>'runId' = ?", [marker, originalRunId]);
    expect(Number(receipt[0]?.['count'])).toBe(1);
    await waitForRunCompleted(originalRunId);

    // Preserve the real item receipt and the runner's journal, but exercise the recovery path where the
    // step result cache was not committed before process loss. This is separate from the held-write SIGKILL cases below.
    await execStack("UPDATE steps SET doc = doc #- '{execution,result}' WHERE id = ?", [original.id]);
    const cacheMissing = await queryStack('SELECT doc FROM steps WHERE id = ?', [original.id]);
    expect((cacheMissing[0]?.['doc'] as { execution?: { result?: unknown; fencedAt?: string } })?.execution)
      .toMatchObject({ fencedAt: original.execution?.fencedAt });
    expect((cacheMissing[0]?.['doc'] as { execution?: { result?: unknown } })?.execution?.result).toBeUndefined();
    await restartAgentd();

    const followup = 'Check and reconcile the earlier delivery.';
    scriptModel(first.sessionKey, [
      { matchLastText: followup, step: 0, toolCalls: [toolCall('reconcile-receipt', 'send_message', { kind: 'text', purpose: 'result', text: marker })] },
      { matchLastText: followup, step: 1, text: 'The saved delivery receipt confirms the earlier post.' },
    ]);
    expect((await sendFollowUp(account, first.conversationId, followup)).status).toBe(202);
    const secondRunId = await waitForNewCompletedConversationRun(first.conversationId, originalRunId);
    expect(secondRunId).not.toBe(originalRunId);
    await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('saved delivery receipt confirms')));

    const reconciled = await queryStack('SELECT doc FROM steps WHERE id = ?', [original.id]);
    expect((reconciled[0]?.['doc'] as { execution?: { reconciliation?: { status?: string }; result?: { content?: Array<{ text?: string }> } } })?.execution)
      .toMatchObject({ reconciliation: { status: 'succeeded' }, result: { content: [expect.objectContaining({ text: marker })] } });
    const finalReceipt = await queryStack("SELECT count(*) AS count FROM items WHERE doc->>'markdown' = ? AND doc->>'runId' = ?", [marker, originalRunId]);
    expect(Number(finalReceipt[0]?.['count'])).toBe(1);
    const followupStep = await queryStack("SELECT doc FROM steps WHERE run_id = ? AND doc->>'target' = 'send_message'", [secondRunId]);
    expect(followupStep).toHaveLength(1);
  }, 180_000);

  it.each([false, true])('restarts into an uncertain action: the agent is told, nobody is asked, and an identical call stays held until it has read (background=%s)', async (background) => {
    const connector = await uncertainConnector(true);
    const { account, agentId } = await setupConnector('recovery-unknown', connector);
    try {
      const title = `Crash-window-${randomUUID()}`;
      const text = 'Create this tracker issue once.';
      const first = await scriptedChat(account, agentId, [
        { matchLastText: text, step: 0, toolCalls: [toolCall('create-issue', 'linear_create_issue', { repo: 'e2e/recovery', title, ...(background ? { background: true } : {}) })] },
        { matchLastText: text, step: 1, text: 'I will check before doing anything twice.' },
      ], text);
      await connector.firstSeen;
      const step = await persistedFence(first.conversationId);
      const runId = step.runId;
      expect(connector.calls).toEqual([{ name: 'create_issue', args: { repo: 'e2e/recovery', title } }]);
      expect(connector.effects).toHaveLength(1);

      // The fixture has committed its external effect but deliberately has not returned a result.
      // Killing only the isolated E2E agentd exercises the real PG fence + durable journal window.
      await restartAgentd();
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('may or may not have happened')));
      expect(await askedRequests(account, agentId)).toEqual([]);
      const noticed = await queryStack('SELECT doc FROM steps WHERE id = ?', [step.id]);
      expect((noticed[0]?.['doc'] as { execution?: { notice?: { runId?: string } } })?.execution?.notice).toBeDefined();

      // A second hard restart changes nothing: no card appears and the call is not dispatched again.
      await restartAgentd();
      expect(await askedRequests(account, agentId)).toEqual([]);
      expect(connector.calls).toHaveLength(1);
      // The run that was told about it finishes (a background call returns its notice as a task result that wakes a run of its own).
      await waitForRunCompleted(runId);
      const newest = await queryStack("SELECT id FROM runs WHERE conversation_id = ? AND kind = 'chat' ORDER BY created_at DESC LIMIT 1", [first.conversationId]);
      const previousRunId = String(newest[0]?.['id']);
      await waitForRunCompleted(previousRunId);

      // In a later run the identical call is held back (the agent has not read anything since the notice): nothing is sent.
      scriptModel(first.sessionKey, [
        { matchLastText: 'Try the same tracker action again.', step: 0, toolCalls: [toolCall('same-create-issue', 'linear_create_issue', { repo: 'e2e/recovery', title })] },
        { matchLastText: 'Try the same tracker action again.', step: 1, text: 'The earlier action is still unchecked.' },
      ]);
      expect((await sendFollowUp(account, first.conversationId, 'Try the same tracker action again.')).status).toBe(202);
      const secondRunId = await waitForNewCompletedConversationRun(first.conversationId, previousRunId);
      expect(secondRunId).not.toBe(previousRunId);
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('earlier action is still unchecked')));
      const heldSteps = await queryStack("SELECT doc FROM steps WHERE run_id = ? AND doc->>'target' = 'Tracker · Create issue'", [secondRunId]);
      expect(heldSteps).toHaveLength(1);
      expect(heldSteps[0]?.['doc']).toMatchObject({ tool: 'linear_create_issue', status: 'skipped' });
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(1);
      expect(await askedRequests(account, agentId)).toEqual([]);
    } finally {
      await connector.close();
    }
  }, 180_000);

  it('asks the person one plain question only when the agent cannot tell, and repeats once only after they say so', async () => {
    const connector = await uncertainConnector(false);
    const { account, agentId } = await setupConnector('recovery-retry', connector);
    try {
      const title = `Retry-window-${randomUUID()}`;
      const text = 'Create this tracker issue once, and ask me if you cannot tell.';
      const first = await scriptedChat(account, agentId, [
        { matchLastText: text, step: 0, toolCalls: [toolCall('create-issue-first', 'linear_create_issue', { repo: 'e2e/recovery', title })] },
        { matchLastText: text, step: 1, toolCalls: [toolCall('ask', 'ask_about_uncertain_action', { question: 'The first attempt may not have gone through and I cannot check. Create the issue again?', redoLabel: 'Create again', skipLabel: 'Leave it' })] },
        { matchLastText: text, step: 2, text: 'I asked you.' },
        { matchLastText: 'Create again', step: 0, toolCalls: [toolCall('create-issue-retry', 'linear_create_issue', { repo: 'e2e/recovery', title })] },
        { matchLastText: 'Create again', step: 1, text: 'The retry completed.' },
      ], text);
      await connector.firstSeen;
      const original = await persistedFence(first.conversationId);
      const originalRunId = original.runId;
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(0);

      await restartAgentd();
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('I asked you.')));
      const asked = await askedRequests(account, agentId);
      expect(asked).toHaveLength(1);
      const card = JSON.stringify(asked[0]?.payload);
      expect(card).toContain('Create the issue again?');
      for (const internal of ['linear_create_issue', 'create_issue', 'e2e/recovery', 'fingerprint', 'receipt', 'verify']) expect(card).not.toContain(internal);
      expect(connector.calls).toHaveLength(1);
      await waitForRunCompleted(originalRunId);

      // Their answer reaches the agent as their own message and lets exactly one identical call through, on its own attempt fence.
      expect((await account.api('POST', `/v1/requests/${asked[0]?.id ?? ''}/resolve`, { action: 'answer', answers: { recovery_outcome: 'redo' } })).status).toBe(200);
      await connector.waitForCalls(2);
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('The retry completed.')));
      expect(connector.calls).toEqual([
        { name: 'create_issue', args: { repo: 'e2e/recovery', title } },
        { name: 'create_issue', args: { repo: 'e2e/recovery', title } },
      ]);
      expect(connector.effects).toHaveLength(1);
      const attemptRows = await queryStack("SELECT s.doc FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.doc->>'conversationId' = ? AND s.run_id <> ? AND s.doc->>'target' = 'Tracker · Create issue' ORDER BY s.created_at", [first.conversationId, originalRunId]);
      const retry = attemptRows.map((row) => row['doc'] as { id: string; execution?: { fencedAt?: string; intent?: { attempt?: number; fingerprint?: string } } })
        .find((step) => step.execution?.intent?.attempt === 1);
      expect(retry?.id).not.toBe(original.id);
      expect(retry?.execution?.fencedAt).toBeTruthy();
      expect(retry?.execution?.intent?.fingerprint).toBe(original.execution.intent?.fingerprint);

      // A repeated answer cannot authorize another attempt.
      const duplicate = await account.api('POST', `/v1/requests/${asked[0]?.id ?? ''}/resolve`, { action: 'answer', answers: { recovery_outcome: 'redo' } });
      expect([200, 409]).toContain(duplicate.status);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(connector.calls).toHaveLength(2);
      expect(connector.effects).toHaveLength(1);
      const finalRequest = await queryStack('SELECT doc FROM requests WHERE id = ?', [asked[0]?.id ?? '']);
      expect((finalRequest[0]?.['doc'] as { reconciliation?: { state?: string } })?.reconciliation).toMatchObject({ state: 'completed' });
    } finally {
      await connector.close();
    }
  }, 180_000);
});
