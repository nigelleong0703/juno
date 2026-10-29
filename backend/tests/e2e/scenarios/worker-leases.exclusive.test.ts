import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { createAccount, defaultAgent, execStack, insertDocRow, killWorker, listenEvents, queryStack, scriptedChat, scriptModel, signalWorker, stackUrls, stackWorkers, startSecondCoordinator, startWorker, stopSecondCoordinator, toolCall, waitForTranscript, type Account } from '../harness/client';
import { setupConnector, uncertainConnector } from '../harness/mcp-fixture';

/**
 * Multi-worker execution leases on the real production assembly: one `AGENTD_ROLE=coordinator` process (HTTP, the instance
 * lock, the platform singletons) and execution workers (`AGENTD_ROLE=worker`) as separate OS processes against one Postgres.
 * Needs the split stack: `E2E_WORKERS=2 E2E_PORT_OFFSET=850 E2E_ONLY=worker-leases pnpm test:e2e`; with the default one-process
 * stack there is nothing to prove and the file is skipped. Assertions are on effect counts (external calls, items, step rows,
 * claim and lease rows), never on a final status alone. The lease lifetime of the split stack is 6 s (harness/stack.ts).
 */
const split = stackUrls().workers >= 2;
const logDir = fileURLToPath(new URL('../../../.data/e2e/logs/', import.meta.url));
/** pg_locks stores the 64-bit advisory key as two 32-bit halves. */
const LOCK_KEY = 0x6a756e6f61676e74n;
/** Same value as the harness's SPLIT_LEASE_TTL_MS. */
const LEASE_TTL_MS = 6_000;

type LogLine = Record<string, unknown>;
/** The split stack has two workers, numbered as the harness numbers them. */
type WorkerNo = 1 | 2;

/** The JSON log lines one process wrote (pino); a line that is not JSON is dropped. */
function logLinesAt(file: string): LogLine[] {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => { try { return [JSON.parse(line) as LogLine]; } catch { return []; } });
}
const logLines = (name: string): LogLine[] => logLinesAt(`${logDir}${name}.log`);
const workerLog = (index: number): LogLine[] => logLines(`worker-${String(index)}`);

/** How many times each worker claimed this invocation (service + key), from the workers' own `durable: claimed` lines. */
function claims(service: string, key: string): Record<WorkerNo, number> {
  const count = (index: WorkerNo): number => workerLog(index).filter((l) => l['msg'] === 'durable: claimed' && l['service'] === service && l['key'] === key).length;
  return { 1: count(1), 2: count(2) };
}
const totalClaims = (service: string, key: string): number => Object.values(claims(service, key)).reduce((sum, n) => sum + n, 0);

async function until<T>(what: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000, everyMs = 250): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const hasListener = (pid: number): boolean => {
  try {
    return execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false; // lsof exits 1 when it finds nothing
  }
};

interface RunLease { id: string; status: string; attempt: number; epoch: number; owner: string | null }
async function runLease(runId: string): Promise<RunLease | undefined> {
  const row = (await queryStack("SELECT id, status, attempt, epoch, lease_owner FROM invocations WHERE service = 'Run' AND key = ? AND handler = 'run'", [runId]))[0];
  return row === undefined ? undefined : { id: String(row['id']), status: String(row['status']), attempt: Number(row['attempt']), epoch: Number(row['epoch']), owner: row['lease_owner'] === null ? null : String(row['lease_owner']) };
}
const workerIndex = (owner: string): WorkerNo => (owner === 'e2e-worker-1' ? 1 : 2);
const otherWorker = (index: WorkerNo): WorkerNo => (index === 1 ? 2 : 1);

/** The worker that is running this Run right now. */
const runningOn = (runId: string): Promise<{ lease: RunLease; index: WorkerNo }> => until<{ lease: RunLease; index: WorkerNo }>(`run ${runId} to be running on a worker`, async () => {
  const lease = await runLease(runId);
  return lease?.status === 'running' && lease.owner !== null ? { lease, index: workerIndex(lease.owner) } : undefined;
});

const itemsSaying = async (conversationId: string, markdown: string): Promise<number> =>
  Number((await queryStack("SELECT count(*) AS n FROM items WHERE doc->>'conversationId' = ? AND doc->>'markdown' = ?", [conversationId, markdown]))[0]?.['n']);

const runStatus = async (runId: string): Promise<string> => String((await queryStack("SELECT doc->>'status' AS status FROM runs WHERE id = ?", [runId]))[0]?.['status']);

async function stepsOf(account: Account, runId: string, target: string): Promise<Array<{ status?: string; execution?: { result?: unknown } }>> {
  const run = await account.api('GET', `/v1/runs/${runId}`);
  return ((run.body.steps ?? []) as Array<{ target?: string; status?: string }>).filter((step) => step.target === target);
}

async function newAgent(account: Account, name: string): Promise<string> {
  const agent = await account.api('POST', '/v1/agents', { name });
  expect(agent.status).toBe(201);
  return agent.body.id as string;
}

describe.skipIf(!split)('coordinator + execution workers: boot', () => {
  it('runs one platform singleton set on the coordinator and none on the workers', async () => {
    const workers = await stackWorkers();
    expect(workers.map((w) => w.alive)).toEqual(workers.map(() => true));
    // Only the coordinator serves HTTP; a worker listens on nothing.
    expect((await fetch(stackUrls().agentdUrl + '/healthz')).ok).toBe(true);
    for (const worker of workers) expect(hasListener(worker.pid as number), `${worker.id} must not listen on any port`).toBe(false);

    // The instance lock has exactly one holder, and the capability marker workers require is the coordinator's.
    const lock = await queryStack('SELECT count(*)::int AS holders FROM pg_locks WHERE locktype = ? AND granted AND classid = ? AND objid = ?', ['advisory', String(LOCK_KEY >> 32n), String(LOCK_KEY & 0xffffffffn)]);
    expect(lock[0]?.['holders']).toBe(1);
    const marker = await queryStack("SELECT state, generation FROM durable_coordination WHERE name = 'worker-leases'");
    expect(marker[0]?.['state']).toBe('active');

    // Roles are visible in the logs: the coordinator starts the singletons and the HTTP API, a worker skips them.
    const coordinator = logLines('agentd');
    expect(coordinator.some((l) => l['msg'] === 'Starting internal agentd' && l['role'] === 'coordinator')).toBe(true);
    expect(coordinator.some((l) => l['msg'] === 'Worker-lease coordination active')).toBe(true);
    expect(coordinator.some((l) => l['msg'] === 'Execution worker running')).toBe(false);
    expect(coordinator.some((l) => l['msg'] === 'plugin singleton skipped in this role')).toBe(false);
    // The singleton set, each seen on the coordinator: migrations, platform skill seed, push notifier, the HTTP listener.
    const singletons = ['migration done', 'Platform skills seeded', 'APNs is not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY or APNS_KEY_PATH); iOS push is off'];
    for (const singleton of singletons) expect(coordinator.some((l) => l['msg'] === singleton), `coordinator runs: ${singleton}`).toBe(true);
    expect(coordinator.filter((l) => String(l['msg']).startsWith('✓ Internal agentd on'))).toHaveLength(1);
    for (const worker of workers) {
      const lines = workerLog(worker.index);
      expect(lines.some((l) => l['msg'] === 'Starting execution worker'), `${worker.id} start line`).toBe(true);
      expect(lines.some((l) => l['msg'] === 'Execution worker running')).toBe(true);
      expect(lines.some((l) => l['msg'] === 'plugin singleton skipped in this role'), `${worker.id} skips plugin singletons`).toBe(true);
      for (const singleton of [...singletons, 'Worker-lease coordination active']) expect(lines.some((l) => l['msg'] === singleton), `${worker.id} must not run: ${singleton}`).toBe(false);
      expect(lines.some((l) => String(l['msg']).startsWith('✓ Internal agentd on'))).toBe(false);
    }
  });

  it('keeps a second coordinator waiting on the lock with no port open', async () => {
    const generationBefore = (await queryStack("SELECT generation FROM durable_coordination WHERE name = 'worker-leases'"))[0]?.['generation'];
    const second = await startSecondCoordinator();
    try {
      await until('the second coordinator to report the lock', () => (logLinesAt(second.logFile).some((l) => String(l['msg']).includes('holds the instance lock; waiting')) ? true : undefined), 30_000);
      await pause(4_000);
      expect(hasListener(second.pid), 'a waiting coordinator must not open a port').toBe(false);
      await expect(fetch(`http://127.0.0.1:${String(second.port)}/healthz`, { signal: AbortSignal.timeout(1_500) })).rejects.toThrow();
      const lines = logLinesAt(second.logFile);
      expect(lines.some((l) => String(l['msg']).includes('Internal agentd on'))).toBe(false);
      expect(lines.some((l) => l['msg'] === 'Worker-lease coordination active')).toBe(false);
      // The first coordinator is untouched: still the only holder, same marker generation.
      expect((await queryStack("SELECT generation FROM durable_coordination WHERE name = 'worker-leases'"))[0]?.['generation']).toBe(generationBefore);
      expect((await fetch(stackUrls().agentdUrl + '/healthz')).ok).toBe(true);
    } finally {
      await stopSecondCoordinator();
    }
  });

  it('spreads real work over both workers, each run claimed exactly once', async () => {
    // Twelve chats arrive at once and each tool call takes 3 s of real work (a slow external API). A worker takes at most four
    // due rows per pass, so the backlog is shared with the other worker instead of being claimed by whoever polls first.
    const count = 12;
    const connector = await uncertainConnector(true, { delayAllCallsMs: 3_000 });
    const { account, agentId } = await setupConnector('wl-spread', connector);
    const events = await listenEvents(account.cookie);
    try {
      const chats = await Promise.all(Array.from({ length: count }, async (_unused, n) => {
        const title = `Spread-${String(n)}-${randomUUID().slice(0, 8)}`;
        const marker = `SPREAD-${String(n)}-${randomUUID().slice(0, 8)}`;
        const text = `file issue ${title}`;
        const chat = await scriptedChat(account, agentId, [
          { matchLastText: text, step: 0, toolCalls: [toolCall(`issue-${String(n)}`, 'linear_create_issue', { repo: 'e2e/leases', title })] },
          { matchLastText: text, step: 1, text: marker },
        ], text);
        return { ...chat, marker, title };
      }));
      for (const chat of chats) await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === chat.conversationId && String(e.data.item?.markdown) === chat.marker, 90_000);
      const runIds = chats.map((chat) => String(events.events.find((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === chat.conversationId)?.data.metadata.juno.run.id));
      expect(new Set(runIds).size).toBe(count);
      let onFirst = 0;
      let onSecond = 0;
      for (const runId of runIds) {
        const mine = claims('Run', runId);
        expect(mine[1] + mine[2], `run ${runId} is claimed exactly once`).toBe(1);
        onFirst += mine[1];
        onSecond += mine[2];
      }
      expect(onFirst, 'worker 1 ran some of the work').toBeGreaterThan(0);
      expect(onSecond, 'worker 2 ran some of the work').toBeGreaterThan(0);
      // The external system saw each issue exactly once, and every chat got its one reply.
      expect(connector.calls.map((call) => call.args['title']).sort()).toEqual(chats.map((chat) => chat.title).sort());
      expect(connector.effects).toHaveLength(count);
      for (const chat of chats) expect(await itemsSaying(chat.conversationId, chat.marker)).toBe(1);
    } finally {
      events.close();
      await connector.close();
    }
  }, 150_000);

  it('re-reads an agent\'s app permission at effect time, not as it was when the worker booted', async () => {
    const connector = await uncertainConnector(false);
    try {
      const { account, agentId } = await setupConnector('wl-permission', connector);
      const first = await scriptedChat(account, agentId, [
        { matchLastText: 'create one', step: 0, toolCalls: [toolCall('issue-1', 'linear_create_issue', { repo: 'e2e/leases', title: 'allowed' })] },
        { matchLastText: 'create one', step: 1, text: 'first done' },
      ], 'create one');
      await connector.firstSeen;
      connector.releaseFirst();
      await waitForTranscript(first.sessionKey, (rows) => rows.some((row) => row.includes('no issue was created')));
      expect(connector.calls).toHaveLength(1);

      // The owner turns the app off for this agent through the coordinator; a worker that booted earlier must refuse the next call.
      expect((await account.api('PUT', `/v1/agents/${agentId}/apps/linear`, { enabled: false })).status).toBe(200);
      const second = await scriptedChat(account, agentId, [
        { matchLastText: 'create another', step: 0, toolCalls: [toolCall('issue-2', 'linear_create_issue', { repo: 'e2e/leases', title: 'revoked' })] },
        { matchLastText: 'create another', step: 1, text: 'second done' },
      ], 'create another');
      await waitForTranscript(second.sessionKey, (rows) => rows.some((row) => row.includes('second done')));
      expect(connector.calls, 'the revoked app was not called').toHaveLength(1);
    } finally {
      await connector.close();
    }
  }, 120_000);

  it('keeps reading the app catalog after the workers booted', async () => {
    // Catalog edit made through the admin API after boot: a worker sees it on its next catalog refresh (10 s), not only at restart.
    const adminToken = 'e2e-admin-token-0123456789';
    const admin = (method: string, path: string, body?: unknown): Promise<Response> =>
      fetch(stackUrls().apiUrl + path, { method, headers: { authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const connector = await uncertainConnector(true);
    try {
      const account = await createAccount('wl-catalog');
      const juno = await defaultAgent(account);
      const appId = `e2e-wl-${randomUUID().slice(0, 6)}`;
      const face = { displayName: 'Worker Notes', shortDescription: 'Notes for the worker test.', longDescription: 'Search and add notes.', icon: 'notes', defaultPrompts: ['Find my notes'] };
      const skill = { name: 'overview', description: 'How Worker Notes works. Use when the person asks about their notes.', instructions: 'Notes live in notebooks.' };
      expect((await admin('POST', '/admin/v1/apps', { id: appId, category: 'work', interface: face, mcpServers: { notes: { type: 'streamable-http', url: connector.url, auth: 'none' } }, skills: [skill] })).status).toBe(201);
      await insertDocRow('connections', account.userId, { id: `con-${appId}`, kind: 'mcp', name: 'Worker Notes', status: 'connected', enabled: true, catalogId: appId, connectedAt: new Date().toISOString(), endpoint: connector.url, transport: 'http' });
      await pause(13_000); // one catalog refresh period plus margin
      const added = await scriptedChat(account, juno.id, [{ text: 'ok' }], 'hello');
      await waitForTranscript(added.sessionKey, (rows) => rows.some((row) => row.includes('- Worker Notes: ')), 45_000);
      expect((await admin('POST', `/admin/v1/apps/${appId}/retire`)).status).toBe(200);
      await pause(13_000);
      const retired = await scriptedChat(account, juno.id, [{ text: 'ok' }], 'hello again');
      await waitForTranscript(retired.sessionKey, (rows) => rows.some((row) => row.includes('## Where you are')), 45_000);
      const after = (await waitForTranscript(retired.sessionKey, (rows) => rows.length > 0)).join('\n');
      expect(after).not.toContain('Worker Notes');
    } finally {
      await connector.close();
    }
  }, 150_000);
});

describe.skipIf(!split)('execution workers: cross-process behaviour', () => {
  // Whatever a scenario did to the fleet, the next one starts with every worker alive, running and unfrozen.
  afterEach(async () => {
    for (const worker of await stackWorkers()) {
      if (!worker.alive) await startWorker(worker.index);
      else await signalWorker(worker.index, 'SIGCONT');
    }
  });

  /** An approval raised by a run on one worker, with the decision taken on the coordinator over HTTP. */
  async function approvalRun(prefix: string) {
    const account = await createAccount(prefix);
    const events = await listenEvents(account.cookie);
    const agentId = await newAgent(account, 'Careful');
    expect((await account.api('POST', '/v1/rules', { description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true })).status).toBeLessThan(300);
    const done = `APPROVED-${randomUUID().slice(0, 8)}`;
    const { conversationId } = await scriptedChat(account, agentId, [{ toolCalls: [toolCall('call-dir', 'agent_directory')] }, { text: done }], 'who else is on the team?');
    const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
    return { account, events, conversationId, done, requestId: created.data.request.id as string, runId: created.data.request.runId as string };
  }

  it('resolves an approval raised on one worker through the coordinator and resumes the run once', async () => {
    const { account, events, conversationId, done, requestId, runId } = await approvalRun('wl-approval');
    try {
      const owner = await runningOn(runId);
      expect(await stepsOf(account, runId, 'agent_directory'), 'nothing ran before the decision').toEqual([]);
      expect(await itemsSaying(conversationId, done)).toBe(0);

      expect((await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown) === done, 30_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);

      expect(await itemsSaying(conversationId, done)).toBe(1);
      expect((await stepsOf(account, runId, 'agent_directory')).map((s) => s.status)).toEqual(['completed']);
      // The run never left the worker that raised the request: one claim, one attempt, no replay.
      const lease = await runLease(runId);
      expect(lease).toMatchObject({ status: 'done', attempt: 1 });
      expect(claims('Run', runId)[owner.index]).toBe(1);
      expect(totalClaims('Run', runId)).toBe(1);
    } finally {
      events.close();
    }
  }, 120_000);

  it('resumes an approval on the other worker when the first one dies before the decision, and runs the tool once', async () => {
    const { account, events, conversationId, done, requestId, runId } = await approvalRun('wl-approval-failover');
    try {
      const first = await runningOn(runId);
      await killWorker(first.index);
      // The decision lands while no worker owns the run: the coordinator only stores it.
      expect((await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown) === done, 60_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);

      expect(await itemsSaying(conversationId, done)).toBe(1);
      expect((await stepsOf(account, runId, 'agent_directory')).map((s) => s.status)).toEqual(['completed']);
      const lease = await runLease(runId);
      expect(lease).toMatchObject({ status: 'done', attempt: 2 });
      expect(lease?.epoch).toBeGreaterThan(first.lease.epoch);
      const mine = claims('Run', runId);
      expect(mine[first.index]).toBe(1);
      expect(mine[otherWorker(first.index)]).toBe(1);
    } finally {
      events.close();
    }
  }, 120_000);

  it('delivers a stop to a run executing on a worker, and the run ends once with nothing posted afterwards', async () => {
    const account = await createAccount('wl-stop');
    const events = await listenEvents(account.cookie);
    try {
      const agentId = await newAgent(account, 'Sleeper');
      const never = `NEVER-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agentId, [{ toolCalls: [toolCall('call-wait', 'wake_at', { when: '+30s' })] }, { text: never }], 'wait half a minute then say something');
      const step = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = step.data.metadata.juno.runId;
      const owner = await runningOn(runId);

      expect((await account.api('POST', `/v1/runs/${runId}/stop`)).status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);
      expect(finished.data.metadata.juno.run.status).toBe('stopped');
      await pause(2_000);
      expect(events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId)).toHaveLength(1);
      expect(await itemsSaying(conversationId, never)).toBe(0);
      expect(await runStatus(runId)).toBe('stopped');
      expect(claims('Run', runId)[owner.index]).toBe(1);
      expect(totalClaims('Run', runId)).toBe(1);
    } finally {
      events.close();
    }
  }, 120_000);

  it('does not let a frozen worker that wakes up after its lease was taken over resurrect a run that was stopped', async () => {
    const account = await createAccount('wl-stop-frozen');
    const events = await listenEvents(account.cookie);
    let frozen: number | undefined;
    try {
      const agentId = await newAgent(account, 'Sleeper');
      const never = `NEVER-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agentId, [{ toolCalls: [toolCall('call-wait', 'wake_at', { when: '+13s' })] }, { text: never }], 'wait and then say something');
      const step = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const startedAt = Date.now();
      const runId: string = step.data.metadata.juno.runId;
      const owner = await runningOn(runId);
      const survivor = otherWorker(owner.index);

      // The owner stalls (it can neither renew nor write); after the database deadline the other worker takes the run over.
      await signalWorker(owner.index, 'SIGSTOP');
      frozen = owner.index;
      await until('the other worker to take the run over', async () => ((await runLease(runId))?.attempt ?? 0) >= 2 ? true : undefined, 40_000);
      expect(claims('Run', runId)[survivor]).toBe(1);

      // The stop arrives while the original owner is still frozen; the new owner honours it.
      expect((await account.api('POST', `/v1/runs/${runId}/stop`)).status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);
      expect(finished.data.metadata.juno.run.status).toBe('stopped');
      const stoppedLease = await runLease(runId);

      // Thaw the old owner after the moment its sleep was due: everything it now tries to write carries a dead epoch.
      await pause(Math.max(0, startedAt + 15_000 - Date.now()));
      await signalWorker(owner.index, 'SIGCONT');
      frozen = undefined;
      await until('the thawed worker to notice it lost the lease', () => (workerLog(owner.index).some((l) => l['msg'] === 'durable: lease lost; cancelling this execution' && l['id'] === owner.lease.id) ? true : undefined), 30_000);
      await pause(4_000);

      expect(await runStatus(runId)).toBe('stopped');
      expect(events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId)).toHaveLength(1);
      expect(await itemsSaying(conversationId, never)).toBe(0);
      const lease = await runLease(runId);
      expect(lease?.status).toBe('done');
      expect(lease?.epoch).toBe(stoppedLease?.epoch);
      expect(lease?.attempt).toBe(stoppedLease?.attempt);
    } finally {
      if (frozen !== undefined) await signalWorker(frozen, 'SIGCONT');
      events.close();
    }
  }, 150_000);

  it('runs a child task on one worker while its parent runs on another, and hands the result back once', async () => {
    const connector = await uncertainConnector(true);
    const { account, agentId } = await setupConnector('wl-child', connector);
    const events = await listenEvents(account.cookie);
    let restored = false;
    try {
      // Each worker uses one invocation at a time. The parent sits in a tool call held open by the connector (running code, so it
      // keeps its worker's only slot), hence the child it spawns can only be taken by the other worker.
      for (const index of [1, 2]) { await killWorker(index); await startWorker(index, 1); }
      restored = true;
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agentId}:${conversationId}`;
      const finishedText = `CHILD-DONE-${randomUUID().slice(0, 8)}`;
      const parentText = 'please research and file an issue';
      scriptModel(`${sessionKey}::child:*`, [{ text: finishedText }]);
      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'research it', notify: true })] },
        { toolCalls: [toolCall('call-issue', 'linear_create_issue', { repo: 'e2e/leases', title: 'child-parent' })] },
        { text: 'on it' }, { text: 'noted' }, { text: 'noted' }, { text: 'noted' },
      ]);
      const path = `/v1/conversations/${conversationId}/runs`;
      expect((await account.api('POST', path, aguiInput(path, { text: parentText }))).status).toBe(202);
      await connector.firstSeen;
      const parentRun = String((await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 30_000)).data.metadata.juno.run.id);
      const childRun = await until('the child run row', async () => {
        const rows = await queryStack('SELECT id FROM runs WHERE conversation_id = ? AND id <> ?', [conversationId, parentRun]);
        return rows[0] === undefined ? undefined : String(rows[0]['id']);
      }, 40_000);
      // The child runs to the end on the other worker while the parent is still inside its tool call; only then the call returns,
      // and the parent's next turn picks the child's result up.
      await until('the child run to finish', async () => (await runLease(childRun))?.status === 'done' ? true : undefined, 60_000);
      connector.releaseFirst();
      await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes('[background task finished')), 60_000);
      await until('the parent to answer', async () => ((await itemsSaying(conversationId, 'on it')) >= 1 ? true : undefined), 60_000);

      const parentClaims = claims('Run', parentRun);
      const childClaims = claims('Run', childRun);
      expect(parentClaims[1] + parentClaims[2], 'the parent run was claimed once').toBe(1);
      expect(childClaims[1] + childClaims[2], 'the child run was claimed once').toBe(1);
      const parentOn = parentClaims[1] === 1 ? 1 : 2;
      expect(childClaims[parentOn], 'the child did not run on the parent\'s worker').toBe(0);
      const transcript = await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes(finishedText)));
      const completions = transcript.filter((row) => row.includes('[background task finished'));
      expect(completions).toHaveLength(1);
      expect(completions[0]).toContain(finishedText);
      expect(connector.calls).toHaveLength(1);
      expect(Number((await queryStack("SELECT count(*) AS n FROM invocations WHERE service = 'Run' AND key = ? AND handler = 'run'", [childRun]))[0]?.['n'])).toBe(1);
    } finally {
      if (restored) for (const index of [1, 2]) { await killWorker(index); await startWorker(index); }
      events.close();
      await connector.close();
    }
  }, 180_000);

  it('fires a durable timer exactly once on the other worker after the worker that owned it is killed', async () => {
    const account = await createAccount('wl-timer');
    const events = await listenEvents(account.cookie);
    try {
      const agentId = await newAgent(account, 'Timer');
      const marker = `TIMER-${randomUUID().slice(0, 8)}`;
      const requestedAt = Date.now();
      const { conversationId } = await scriptedChat(account, agentId, [{ toolCalls: [toolCall('call-wait', 'wake_at', { when: '+12s' })] }, { text: marker }], 'wait twelve seconds then say it');
      const step = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = step.data.metadata.juno.runId;
      const first = await runningOn(runId);
      await killWorker(first.index);

      const reply = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown) === marker, 60_000);
      expect(Date.now() - requestedAt, 'the timer did not fire early').toBeGreaterThanOrEqual(11_000);
      expect(String(reply.data.item.runId)).toBe(runId);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);
      await pause(2_000);
      expect(await itemsSaying(conversationId, marker)).toBe(1);
      expect((await stepsOf(account, runId, 'wake_at')).map((s) => s.status)).toEqual(['completed']);
      expect(await runLease(runId)).toMatchObject({ status: 'done', attempt: 2 });
      expect(claims('Run', runId)).toEqual({ [first.index]: 1, [otherWorker(first.index)]: 1 });
    } finally {
      events.close();
    }
  }, 150_000);

  /** A chat that makes the agent call the tracker's write tool once, then report. */
  async function trackerRun(prefix: string, connector: Awaited<ReturnType<typeof uncertainConnector>>) {
    const { account, agentId } = await setupConnector(prefix, connector);
    const title = `Issue-${randomUUID().slice(0, 8)}`;
    const text = `Create the tracker issue ${title} once.`;
    const reported = `REPORTED-${randomUUID().slice(0, 8)}`;
    const chat = await scriptedChat(account, agentId, [
      { matchLastText: text, step: 0, toolCalls: [toolCall('create-issue', 'linear_create_issue', { repo: 'e2e/leases', title })] },
      { matchLastText: text, step: 1, text: reported },
    ], text);
    await connector.firstSeen;
    const rows = await queryStack("SELECT s.run_id, s.doc FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.doc->>'conversationId' = ? AND s.doc->>'target' = 'Tracker · Create issue' ORDER BY s.created_at LIMIT 1", [chat.conversationId]);
    const runId = String(rows[0]?.['run_id']);
    const step = rows[0]?.['doc'] as { id: string; execution?: { fencedAt?: string; result?: unknown } };
    expect(step.execution?.fencedAt, 'the dangerous call is fenced before it is sent').toBeTruthy();
    return { account, agentId, title, reported, runId, stepId: step.id, ...chat };
  }

  const recoveryRequests = async (account: Account, agentId: string): Promise<Array<{ id: string; title: string }>> =>
    (((await account.api('GET', `/v1/requests?agentId=${encodeURIComponent(agentId)}&status=pending&kind=question`)).body.items ?? []) as Array<{ id: string; title: string }>).filter((r) => r.title === 'Check an uncertain action');

  it('takes over a killed worker\'s run mid-tool without sending the fenced write again', async () => {
    const connector = await uncertainConnector(true);
    try {
      const { account, agentId, runId, stepId, sessionKey } = await trackerRun('wl-kill-midtool', connector);
      const first = await runningOn(runId);
      expect(connector.effects).toHaveLength(1);
      const killedAt = Date.now();
      await killWorker(first.index);

      // After the database deadline the other worker takes the run over, replays its journal and finds the fence with no result.
      const request = await until('the recovery request', async () => (await recoveryRequests(account, agentId))[0], 60_000);
      expect(Date.now() - killedAt, 'no takeover before the lease deadline').toBeGreaterThanOrEqual(LEASE_TTL_MS - 2_000);
      const lease = await runLease(runId);
      expect(lease?.attempt).toBe(2);
      expect(lease?.epoch).toBeGreaterThan(first.lease.epoch);
      const mine = claims('Run', runId);
      expect(mine[first.index]).toBe(1);
      expect(mine[otherWorker(first.index)]).toBe(1);
      // The write that may already have happened is not sent again, and the owner is asked instead of the system guessing.
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(1);
      expect(await recoveryRequests(account, agentId)).toHaveLength(1);
      const saved = await queryStack('SELECT doc FROM requests WHERE id = ?', [request.id]);
      expect((saved[0]?.['doc'] as { reconciliation?: { state?: string; stepId?: string } }).reconciliation).toMatchObject({ state: 'pending', stepId });

      expect((await account.api('POST', `/v1/requests/${request.id}/resolve`, { action: 'answer', answers: { recovery_outcome: 'still_unknown' } })).status).toBe(200);
      await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes('outcome is still unknown')));
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(1);
    } finally {
      await connector.close();
    }
  }, 180_000);

  it('rejects the late write of a worker that was frozen mid-tool after another worker took its run over', async () => {
    const connector = await uncertainConnector(true);
    let frozen: number | undefined;
    try {
      const { account, agentId, runId, stepId, sessionKey } = await trackerRun('wl-frozen-midtool', connector);
      const first = await runningOn(runId);
      const firstClaim = workerLog(first.index).filter((l) => l['msg'] === 'durable: claimed' && l['key'] === runId && l['service'] === 'Run').map((l) => Number(l['epoch']))[0];
      await signalWorker(first.index, 'SIGSTOP');
      frozen = first.index;
      const request = await until('the recovery request from the new owner', async () => (await recoveryRequests(account, agentId))[0], 60_000);
      const takenOver = await runLease(runId);
      expect(takenOver?.attempt).toBe(2);
      expect(takenOver?.epoch).toBeGreaterThan(firstClaim as number);

      // The held external answer now reaches the frozen worker, which wakes up holding a dead epoch and tries to record it.
      connector.releaseFirst();
      await pause(500);
      await signalWorker(first.index, 'SIGCONT');
      frozen = undefined;
      await until('the thawed worker to notice it lost the lease', () => (workerLog(first.index).some((l) => l['msg'] === 'durable: lease lost; cancelling this execution' && l['id'] === first.lease.id) ? true : undefined), 30_000);
      await pause(4_000);

      const stepRow = await queryStack('SELECT doc FROM steps WHERE id = ?', [stepId]);
      const execution = (stepRow[0]?.['doc'] as { execution?: { fencedAt?: string; result?: unknown } }).execution;
      expect(execution?.fencedAt).toBeTruthy();
      expect(execution?.result, 'the stale worker must not store the tool result').toBeUndefined();
      expect(await recoveryRequests(account, agentId)).toEqual([expect.objectContaining({ id: request.id })]);
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(1);
      expect((await runLease(runId))?.epoch).toBe(takenOver?.epoch);

      expect((await account.api('POST', `/v1/requests/${request.id}/resolve`, { action: 'answer', answers: { recovery_outcome: 'still_unknown' } })).status).toBe(200);
      await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes('outcome is still unknown')));
      expect(connector.calls).toHaveLength(1);
    } finally {
      if (frozen !== undefined) await signalWorker(frozen, 'SIGCONT');
      await connector.close();
    }
  }, 180_000);

  it('renews the lease of a step that outlasts it, so no other worker takes it', async () => {
    const connector = await uncertainConnector(true);
    try {
      const { account, agentId, runId, reported, conversationId } = await trackerRun('wl-renew', connector);
      const first = await runningOn(runId);
      // Hold the tool for two and a half lease lifetimes while the other worker keeps polling for expired leases.
      const before = await runLease(runId);
      await pause(LEASE_TTL_MS * 2.5);
      const during = await runLease(runId);
      expect(during).toMatchObject({ status: 'running', attempt: 1, epoch: before?.epoch, owner: first.lease.owner });
      expect(totalClaims('Run', runId)).toBe(1);

      connector.releaseFirst();
      await until('the run to report', async () => ((await itemsSaying(conversationId, reported)) === 1 ? true : undefined), 60_000);
      expect(await runLease(runId)).toMatchObject({ status: 'done', attempt: 1, epoch: before?.epoch });
      expect(totalClaims('Run', runId)).toBe(1);
      expect(connector.calls).toHaveLength(1);
      expect(connector.effects).toHaveLength(1);
      expect(await recoveryRequests(account, agentId)).toEqual([]);
      expect(workerLog(first.index).some((l) => l['msg'] === 'durable: lease lost; cancelling this execution' && l['id'] === first.lease.id)).toBe(false);
    } finally {
      await connector.close();
    }
  }, 180_000);

  it('fails closed without an active lease-aware coordinator: workers claim nothing and a new worker refuses to start', async () => {
    // An older, lease-less agentd never writes the capability marker; a drained or stale marker looks the same to a worker.
    const account = await createAccount('wl-gate');
    const events = await listenEvents(account.cookie);
    try {
      const agentId = await newAgent(account, 'Gate');
      await execStack("UPDATE durable_coordination SET state = 'drained' WHERE name = 'worker-leases'");
      await pause(7_000); // the workers re-check the marker every 5 s
      const claimedBefore = [1, 2].reduce((sum, n) => sum + workerLog(n).filter((l) => l['msg'] === 'durable: claimed').length, 0);

      const marker = `GATED-${randomUUID().slice(0, 8)}`;
      let chat: Awaited<ReturnType<typeof scriptedChat>> | undefined;
      let sendError: unknown;
      // The coordinator stores the message and the wake and waits for a decision; nothing claims it while the gate is shut.
      const sending = scriptedChat(account, agentId, [{ text: marker }], 'say something').then((sent) => { chat = sent; }, (error: unknown) => { sendError = error; });
      await pause(6_000);
      const claimedDuring = [1, 2].reduce((sum, n) => sum + workerLog(n).filter((l) => l['msg'] === 'durable: claimed').length, 0);
      expect(claimedDuring, 'no worker claimed anything with the marker drained').toBe(claimedBefore);

      // A worker started now exits instead of joining the fleet.
      await killWorker(2);
      await expect(startWorker(2)).rejects.toThrow(/refusing to start an execution worker/);

      // The marker comes back (a new lease-aware coordinator publishes it): the stored work runs, once.
      await execStack("UPDATE durable_coordination SET state = 'active', heartbeat_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE name = 'worker-leases'");
      await startWorker(2);
      await sending;
      if (chat === undefined) throw sendError;
      const conversationId = chat.conversationId;
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown) === marker, 60_000);
      await pause(1_000);
      expect(await itemsSaying(conversationId, marker)).toBe(1);
    } finally {
      await execStack("UPDATE durable_coordination SET state = 'active', heartbeat_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE name = 'worker-leases'");
      events.close();
    }
  }, 180_000);
});
