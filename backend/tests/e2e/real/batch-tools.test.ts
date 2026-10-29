import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, queryStack, runReport, type Account, type EventListener } from '../harness/client';

/**
 * M-BATCH-TOOLS measurement (real model). Two tasks the same way on any branch, so main and the batch branch compare:
 *  - reads: four independent web_fetch reads in one request (does the model send them together?).
 *  - form: a local-Docker browser fills a six-field form on a static public page (does the model batch the known steps?).
 * Each run prints one JSON line: model round trips (assistant messages), tool calls, calls that went out in a message with
 * several calls, computer.batch calls and the steps they carried, wall time and pass/fail. E2E_BATCH_LABEL tags the line,
 * E2E_BATCH_REPORT appends it to a file, E2E_BATCH_REPEATS repeats each task. Assertions are behavioural, never wording.
 */
const label = process.env['E2E_BATCH_LABEL'] ?? 'run';
const repeats = Number(process.env['E2E_BATCH_REPEATS'] ?? '1');
const only = process.env['E2E_BATCH_ONLY']?.split(',');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface RunMetrics {
  turns: number;
  toolCalls: number;
  discoveryCalls: number;
  parallelCalls: number;
  maxPerTurn: number;
  batchCalls: number;
  batchSteps: number;
  tools: Record<string, number>;
}

/** What the model did in one session, read from the stored transcript: names are the tools that ran (a proxied call by its inner name). */
async function sessionMetrics(sessionKey: string): Promise<RunMetrics> {
  const rows = await queryStack('select doc from transcripts where kind = ? order by at', [sessionKey]);
  const metrics: RunMetrics = { turns: 0, toolCalls: 0, discoveryCalls: 0, parallelCalls: 0, maxPerTurn: 0, batchCalls: 0, batchSteps: 0, tools: {} };
  for (const row of rows) {
    const doc: unknown = typeof row['doc'] === 'string' ? JSON.parse(row['doc']) : row['doc'];
    if (!isRecord(doc) || !isRecord(doc['message']) || doc['message']['role'] !== 'assistant') continue;
    const content = doc['message']['content'];
    metrics.turns += 1;
    const calls = (Array.isArray(content) ? content : []).filter((part): part is Record<string, unknown> => isRecord(part) && part['type'] === 'toolCall');
    const real = calls.filter((part) => part['name'] !== 'tool_search' && part['name'] !== 'tool_load');
    metrics.discoveryCalls += calls.length - real.length;
    metrics.toolCalls += real.length;
    metrics.maxPerTurn = Math.max(metrics.maxPerTurn, real.length);
    if (real.length >= 2) metrics.parallelCalls += real.length;
    for (const part of real) {
      const args = isRecord(part['arguments']) ? part['arguments'] : {};
      const inner = part['name'] === 'tool_call' && typeof args['name'] === 'string' ? args['name'] : String(part['name']);
      const innerArgs = part['name'] === 'tool_call' && isRecord(args['arguments']) ? args['arguments'] : args;
      metrics.tools[inner] = (metrics.tools[inner] ?? 0) + 1;
      if (inner === 'computer.batch') {
        metrics.batchCalls += 1;
        metrics.batchSteps += Array.isArray(innerArgs['steps']) ? innerArgs['steps'].length : 0;
      }
    }
  }
  return metrics;
}

/** E2E_BATCH_VERBOSE=1: what the model called and what came back, one short line each, to read why a run went the way it did. */
async function dump(sessionKey: string): Promise<void> {
  if (process.env['E2E_BATCH_VERBOSE'] !== '1') return;
  const rows = await queryStack('select doc from transcripts where kind = ? order by at', [sessionKey]);
  for (const row of rows) {
    const doc: unknown = typeof row['doc'] === 'string' ? JSON.parse(row['doc']) : row['doc'];
    if (!isRecord(doc) || !isRecord(doc['message'])) continue;
    const content = doc['message']['content'];
    const parts = Array.isArray(content) ? content : [];
    const text = parts.map((part) => (isRecord(part) ? (part['type'] === 'toolCall' ? `CALL ${String(part['name'])} ${JSON.stringify(part['arguments']).slice(0, 300)}` : String(part['text'] ?? '').slice(0, 300)) : '')).join(' | ');
    console.info(`[batch-tools:${String(doc['message']['role'])}]`, text.replace(/\s+/g, ' ').slice(0, 700));
  }
}

function record(task: string, result: { seconds: number; status: string; approvals: number }, passed: boolean, metrics: RunMetrics): void {
  const line = JSON.stringify({ label, task, seconds: result.seconds, status: result.status, passed, approvals: result.approvals, ...metrics });
  console.info('[batch-tools]', line);
  const output = process.env['E2E_BATCH_REPORT'];
  if (output) appendFileSync(output, line + '\n');
}

/** Sends one message and waits for the run; approval cards that appear meanwhile are approved (the form's Submit asks) and counted. */
async function chat(account: Account, events: EventListener, agentId: string, text: string, timeoutMs: number): Promise<{ conversationId: string; runId: string; status: string; seconds: number; reply: string; approvals: number }> {
  const started = Date.now();
  const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId], firstMessage: { text } });
  expect(created.status).toBe(201);
  const conversationId: string = created.body.id;
  const resolved = new Set<string>();
  let busy = false;
  const approve = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const pending = await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending&kind=approval`);
      const items: unknown = pending.body?.items;
      for (const request of Array.isArray(items) ? items : []) {
        if (!isRecord(request) || typeof request['id'] !== 'string' || resolved.has(request['id'])) continue;
        resolved.add(request['id']);
        await account.api('POST', `/v1/requests/${request['id']}/resolve`, { action: 'approve' });
      }
    })().catch(() => undefined).finally(() => { busy = false; });
  }, 400);
  // A run that never finishes is a result too (status "timeout"), recorded with whatever the model had done by then.
  const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, timeoutMs).catch(() => undefined);
  clearInterval(approve);
  const reply = events.events
    .filter((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message')
    .map((e) => String(e.data.item.markdown)).join('\n---\n');
  return { conversationId, runId: finished?.data.metadata.juno.run.id ?? '', status: finished?.data.metadata.juno.run.status ?? 'timeout', seconds: Math.round((Date.now() - started) / 1000), reply, approvals: resolved.size };
}

const whyNot = async (account: Account, runId: string): Promise<string> => (runId === '' ? 'the run did not finish in time' : runReport(account, runId));

describe.skipIf(only !== undefined && !only.includes('reads'))('real model: independent reads', () => {
  it('fetches four pages for one request', async () => {
    for (let round = 0; round < repeats; round += 1) {
      const account = await createAccount('real-batch-reads');
      const events = await listenEvents(account.cookie);
      try {
        const agent = await defaultAgent(account);
        const urls = ['Singapore', 'Bangkok', 'Tokyo', 'Seoul'].map((city) => `https://en.wikipedia.org/api/rest_v1/page/summary/${city}`);
        const result = await chat(account, events, agent.id, `Fetch these four pages and give me one line on each, so I can compare them:\n${urls.join('\n')}`, 240_000);
        const metrics = await sessionMetrics(`${agent.id}:${result.conversationId}`);
        const passed = result.status === 'completed' && (metrics.tools['web_fetch'] ?? 0) >= 4 && ['Singapore', 'Bangkok', 'Tokyo', 'Seoul'].every((city) => result.reply.includes(city));
        record('reads', result, passed, metrics);
        await dump(`${agent.id}:${result.conversationId}`);
        expect.soft(result.status, await whyNot(account, result.runId)).toBe('completed');
        expect.soft(metrics.tools['web_fetch'] ?? 0).toBeGreaterThanOrEqual(4);
        expect.soft(result.reply).toMatch(/Singapore/);
        expect.soft(result.reply).toMatch(/Seoul/);
      } finally {
        events.close();
      }
    }
  }, 300_000 * Math.max(1, repeats));
});

/** Real model + real local computer (opt-in: E2E_COMPUTER_PROVIDER=local, image juno-desktop:local). */
describe.skipIf(process.env['E2E_COMPUTER_PROVIDER'] !== 'local' || (only !== undefined && !only.includes('form')))('real model + computer: fill a form', () => {
  it('fills six known fields and submits', async () => {
    const containers = () => execFileSync('docker', ['ps', '-aq', '--filter', 'name=agent-local-'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const before = new Set(containers());
    for (let round = 0; round < repeats; round += 1) {
      const account = await createAccount('real-batch-form');
      const events = await listenEvents(account.cookie);
      try {
        const agent = await defaultAgent(account);
        const computer = await account.api('POST', '/v1/computers/ensure', {});
        expect(computer.status, JSON.stringify(computer.body)).toBeLessThan(300);
        const screen = await account.api('POST', `/v1/computers/${computer.body.id}/screens`, { agentId: agent.id });
        expect(screen.status, JSON.stringify(screen.body)).toBeLessThan(300);
        const result = await chat(account, events, agent.id, [
          'Open https://www.selenium.dev/selenium/web/web-form.html in your browser and fill in the form:',
          'Text input: Juno Batch. Textarea: Testing batch tools. Dropdown (datalist): Seattle. Tick Default checkbox. Choose Default radio.',
          'Then press Submit and tell me the message the next page shows. Work in the page itself with your browser (type, tick, click); do not fetch or submit it any other way.',
        ].join('\n'), 420_000);
        const metrics = await sessionMetrics(`${agent.id}:${result.conversationId}`);
        // Passing means the page itself was driven through the browser tools (not a shell/web_fetch shortcut to the submit URL).
        const drove = ['browser.click', 'browser.type', 'browser.fill', 'computer.batch'].some((name) => (metrics.tools[name] ?? 0) > 0);
        const passed = result.status === 'completed' && /received/i.test(result.reply) && drove;
        record('form', result, passed, metrics);
        await dump(`${agent.id}:${result.conversationId}`);
        console.log('REPLY:\n' + result.reply.slice(0, 1500));
        // Soft: every round is measured even when an earlier one failed.
        expect.soft(result.status, await whyNot(account, result.runId)).toBe('completed');
        expect.soft(result.reply, 'final reply carries the page message').toMatch(/received/i);
        expect.soft(drove, 'the form was driven through the browser tools: ' + JSON.stringify(metrics.tools)).toBe(true);
      } finally {
        events.close();
        // Only the containers this test created; a run that hung leaves one behind otherwise.
        const created = containers().filter((id) => !before.has(id));
        if (created.length > 0) execFileSync('docker', ['rm', '-f', ...created]);
      }
    }
  }, 600_000 * Math.max(1, repeats));
});
