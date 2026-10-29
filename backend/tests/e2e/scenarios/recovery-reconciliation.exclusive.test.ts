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

interface RecoveryRequest {
  id: string;
  title: string;
  status: string;
  payload: { ui: { blocks: Array<{ type: string; rows?: unknown[]; options?: Array<{ id: string }> }> } };
}

async function persistedFence(conversationId: string): Promise<{ id: string; runId: string; execution: { fencedAt?: string; intent?: { fingerprint?: string; attempt?: number } } }> {
  const rows = await queryStack("SELECT s.run_id, s.doc FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.doc->>'conversationId' = ? AND s.doc->>'target' = 'Tracker · Create issue' ORDER BY s.created_at LIMIT 1", [conversationId]);
  const step = rows[0]?.['doc'] as { id: string; execution?: { fencedAt?: string; intent?: { fingerprint?: string } } } | undefined;
  expect(step?.execution?.fencedAt, `step execution metadata: ${JSON.stringify(step)}`).toBeTruthy();
  expect(step?.execution?.intent?.fingerprint, `step execution metadata: ${JSON.stringify(step)}`).toMatch(/^[a-f0-9]{64}$/);
  return { ...(step as { id: string; execution: { fencedAt?: string; intent?: { fingerprint?: string; attempt?: number } } }), runId: String(rows[0]?.['run_id']) };
}

async function waitForRecoveryRequest(account: Awaited<ReturnType<typeof createAccount>>, agentId: string): Promise<RecoveryRequest> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await account.api('GET', `/v1/requests?agentId=${encodeURIComponent(agentId)}&status=pending&kind=question`);
    const requests = response.body.items as RecoveryRequest[] | undefined;
    const request = requests?.find((item) => item.title === 'Check an uncertain action');
    if (request !== undefined) return request;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('timed out waiting for the durable recovery request through the owner API');
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
  throw new Error(`no separate completed chat run followed ${previousRunId}`);
}

describe('production PostgreSQL recovery reconciliation after SIGKILL', () => {
  it('reuses a persisted production send_message receipt after restart without posting it twice', async () => {
    const account = await createAccount('recovery-receipt');
    const agent = await defaultAgent(account);
    const marker = `Receipt-${randomUUID()}`;
    const firstText = 'Post this message once.';
    const first = await scriptedChat(account, agent.id, [
      { matchLastText: firstText, step: 0, toolCalls: [toolCall('post-receipt', 'send_message', { kind: 'text', text: marker })] },
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

    // Preserve the real item receipt and Restate journal, but exercise the recovery path where the
    // step result cache was not committed before process loss. This is separate from the held-write SIGKILL cases below.
    await execStack("UPDATE steps SET doc = doc #- '{execution,result}' WHERE id = ?", [original.id]);
    const cacheMissing = await queryStack('SELECT doc FROM steps WHERE id = ?', [original.id]);
    expect((cacheMissing[0]?.['doc'] as { execution?: { result?: unknown; fencedAt?: string } })?.execution)
      .toMatchObject({ fencedAt: original.execution?.fencedAt });
    expect((cacheMissing[0]?.['doc'] as { execution?: { result?: unknown } })?.execution?.result).toBeUndefined();
    await restartAgentd();

    const followup = 'Check and reconcile the earlier delivery.';
    scriptModel(first.sessionKey, [
      { matchLastText: followup, step: 0, toolCalls: [toolCall('reconcile-receipt', 'send_message', { kind: 'text', text: marker })] },
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

  it.each([false, true])('restarts into one durable unknown request and blocks repeated writes (background=%s)', async (background) => {
    const connector = await uncertainConnector(true);
    const { account, agentId } = await setupConnector('recovery-unknown', connector);
    try {
      const title = `Crash-window-${randomUUID()}`;
      const text = 'Create this tracker issue once.';
      const first = await scriptedChat(account, agentId, [
        { matchLastText: text, step: 0, toolCalls: [toolCall('create-issue', 'linear_create_issue', { repo: 'e2e/recovery', title, ...(background ? { background: true } : {}) })] },
        { matchLastText: text, step: 1, text: 'I will leave the uncertain issue unchanged until you check it.' },
      ], text);
      await connector.firstSeen;
      const step = await persistedFence(first.conversationId);
      const runId = step.runId;
      expect(connector.calls).toEqual([{ name: 'create_issue', args: { repo: 'e2e/recovery', title } }]);
      expect(connector.effects).toHaveLength(1);

      // The fixture has committed its external effect but deliberately has not returned a result.
      // Killing only the isolated E2E agentd exercises the real PG fence + Restate journal window.
      await restartAgentd();
      const created = await waitForRecoveryRequest(account, agentId);
      const requestId: string = created.id;
      expect(created.payload.ui.blocks.find((block) => block.type === 'facts')?.rows)
        .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Action', value: 'linear_create_issue' })]));
      expect(created.payload.ui.blocks.find((block) => block.type === 'choices')?.options?.map((option) => option.id))
        .toEqual(['reported_done', 'confirmed_absent_retry', 'still_unknown']);
      const saved = await queryStack('SELECT doc FROM requests WHERE id = ?', [requestId]);
      expect((saved[0]?.['doc'] as { reconciliation?: { state?: string; stepId?: string; fingerprint?: string } })?.reconciliation)
        .toMatchObject({ state: 'pending', stepId: step.id, fingerprint: step.execution.intent?.fingerprint });
      expect((await account.api('GET', `/v1/requests/${requestId}`)).status).toBe(200);

      // A second hard restart must preserve the exact owner decision request and not redispatch the call.
      await restartAgentd();
      const pending = await queryStack('SELECT doc FROM requests WHERE id = ?', [requestId]);
      expect((pending[0]?.['doc'] as { status?: string; reconciliation?: { state?: string } })?.reconciliation)
        .toMatchObject({ state: 'pending' });
      expect(connector.calls).toHaveLength(1);

      if (background) await waitForRunCompleted(runId);
      expect((await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'answer', answers: { recovery_outcome: 'still_unknown' } })).status).toBe(200);
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes(background ? 'outcome remains unknown' : 'outcome is still unknown')));
      await waitForRunCompleted(runId);
      const previousRunId = background ? await waitForNewCompletedConversationRun(first.conversationId, runId) : runId;
      scriptModel(first.sessionKey, [
        { matchLastText: 'Try the same tracker action again.', step: 0, toolCalls: [toolCall('same-create-issue', 'linear_create_issue', { repo: 'e2e/recovery', title })] },
        { matchLastText: 'Try the same tracker action again.', step: 1, text: 'The earlier action remains unresolved.' },
      ]);
      expect((await sendFollowUp(account, first.conversationId, 'Try the same tracker action again.')).status).toBe(202);
      const secondRunId = await waitForNewCompletedConversationRun(first.conversationId, previousRunId);
      expect(secondRunId).not.toBe(previousRunId);
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('earlier action remains unresolved')));
      const guardedSteps = await queryStack("SELECT doc FROM steps WHERE run_id = ? AND doc->>'target' = 'Tracker · Create issue'", [secondRunId]);
      expect(guardedSteps).toHaveLength(1);
      expect(guardedSteps[0]?.['doc']).toMatchObject({ tool: 'linear_create_issue', status: 'skipped', errorKind: 'permission' });
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(1);
      const finalRequest = await queryStack('SELECT doc FROM requests WHERE id = ?', [requestId]);
      expect((finalRequest[0]?.['doc'] as { reconciliation?: { state?: string; source?: string } })?.reconciliation)
        .toMatchObject({ state: 'still_unknown', source: 'owner_report' });
    } finally {
      await connector.close();
    }
  }, 180_000);

  it('retries once with a separate durable attempt fence only after the owner confirms absence', async () => {
    const connector = await uncertainConnector(false);
    const { account, agentId } = await setupConnector('recovery-retry', connector);
    try {
      const title = `Retry-window-${randomUUID()}`;
      const text = 'Create this tracker issue after verifying it is absent.';
      const first = await scriptedChat(account, agentId, [
        { matchLastText: text, step: 0, toolCalls: [toolCall('create-issue-first', 'linear_create_issue', { repo: 'e2e/recovery', title })] },
        { matchLastText: text, step: 1, text: 'The first attempt needs your verification.' },
        { matchLastText: 'I verified it is absent; retry once.', step: 0, toolCalls: [toolCall('create-issue-retry', 'linear_create_issue', { repo: 'e2e/recovery', title })] },
        { matchLastText: 'I verified it is absent; retry once.', step: 1, text: 'The verified retry completed.' },
      ], text);
      await connector.firstSeen;
      const original = await persistedFence(first.conversationId);
      const originalRunId = original.runId;
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(0);

      await restartAgentd();
      const created = await waitForRecoveryRequest(account, agentId);
      const requestId: string = created.id;
      const saved = await queryStack('SELECT doc FROM requests WHERE id = ?', [requestId]);
      expect((saved[0]?.['doc'] as { reconciliation?: { state?: string; stepId?: string } })?.reconciliation)
        .toMatchObject({ state: 'pending', stepId: original.id });

      expect((await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'answer', answers: { recovery_outcome: 'confirmed_absent_retry' } })).status).toBe(200);
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('authorized one retry')));
      expect(connector.calls).toHaveLength(1);
      await waitForRunCompleted(originalRunId);
      expect((await sendFollowUp(account, first.conversationId, 'I verified it is absent; retry once.')).status).toBe(202);
      await connector.waitForCalls(2);
      await waitForTranscript(first.sessionKey, (messages) => messages.some((message) => message.includes('verified retry completed')));
      const runRows = await queryStack("SELECT id FROM runs WHERE conversation_id = ? AND kind = 'chat' ORDER BY created_at DESC LIMIT 1", [first.conversationId]);
      const retryRunId = String(runRows[0]?.['id']);
      expect(retryRunId).not.toBe(originalRunId);

      expect(connector.calls).toEqual([
        { name: 'create_issue', args: { repo: 'e2e/recovery', title } },
        { name: 'create_issue', args: { repo: 'e2e/recovery', title } },
      ]);
      expect(connector.effects).toHaveLength(1);
      const attemptRows = await queryStack("SELECT s.doc FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.doc->>'conversationId' = ? AND s.run_id <> ? AND s.doc->>'target' = 'Tracker · Create issue' ORDER BY s.created_at", [first.conversationId, originalRunId]);
      const retry = attemptRows.map((row) => row['doc'] as { id: string; verb?: string; execution?: { fencedAt?: string; intent?: { attempt?: number; fingerprint?: string } } })
        .find((step) => step.execution?.intent?.attempt === 1);
      expect(retry?.id).not.toBe(original.id);
      expect(retry?.execution?.fencedAt).toBeTruthy();
      expect(retry?.execution?.intent?.fingerprint).toBe(original.execution.intent?.fingerprint);

      // A repeated answer to the already resolved request cannot authorize another attempt.
      const duplicate = await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'answer', answers: { recovery_outcome: 'confirmed_absent_retry' } });
      expect([200, 409]).toContain(duplicate.status);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(connector.calls).toHaveLength(2);
      expect(connector.effects).toHaveLength(1);
      const finalRequest = await queryStack('SELECT doc FROM requests WHERE id = ?', [requestId]);
      expect((finalRequest[0]?.['doc'] as { reconciliation?: { state?: string } })?.reconciliation).toMatchObject({ state: 'retry_completed' });
    } finally {
      await connector.close();
    }
  }, 180_000);
});
