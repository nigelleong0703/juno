import { aguiInput } from '../../agui-input.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, listenEvents, toolActivity, queryStack, runReport } from '../harness/client';

const enabled = process.env['E2E_DISCLOSURE_BENCH'] === '1';
const repeats = Number(process.env['E2E_DISCLOSURE_REPEATS'] ?? '2');
const AT = new Date().toISOString();
const record = (value: unknown): void => {
  console.info('[disclosure-benchmark]', JSON.stringify(value));
  const output = process.env['E2E_DISCLOSURE_REPORT'];
  if (output) appendFileSync(output, JSON.stringify(value) + '\n');
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function metrics(): Promise<unknown[]> {
  const base = process.env['E2E_DISCLOSURE_METRICS'];
  if (!base) return [];
  const body: unknown = await (await fetch(base + '/metrics')).json();
  return Array.isArray(body) ? body : [];
}

const selectedChineseScenario = (): boolean => process.env['E2E_DISCLOSURE_SCENARIOS']?.split(',').includes('read-zh') === true;

async function fixture() {
  const received: Array<{ name: string; at: number }> = [];
  const tools = Array.from({ length: 30 }, (_, index) => {
    if (index === 28) return { name: 'search_notes', description: 'Search saved note text for the latest meeting code or other detail.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } };
    if (index === 29) return { name: 'create_note', description: 'Create a saved note from title and body.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } };
    return { name: 'list_label_' + String(index), description: 'List notes with the exact label ' + String(index) + '. This does not search note text.', inputSchema: { type: 'object', properties: { label: { type: 'string' } } }, annotations: { readOnlyHint: true } };
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.writeHead(204).end(); return; }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!isRecord(raw)) { response.writeHead(400).end(); return; }
      const reply = (result: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: raw['id'], result })); };
      if (raw['method'] === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' }, instructions: 'Search for an existing note before creating a new note.' });
      if (raw['method'] === 'tools/list') return reply({ tools });
      if (raw['method'] === 'tools/call') {
        const params = raw['params'];
        const name = isRecord(params) && typeof params['name'] === 'string' ? params['name'] : '';
        received.push({ name, at: performance.now() });
        return reply({ content: [{ type: 'text', text: name === 'search_notes' ? 'Current meeting code: MEETING-4821. No existing note with the title Bench Groceries.' : name === 'create_note' ? 'Created Bench Groceries.' : 'No notes carry this label.' }] });
      }
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture has no port');
  return { received, endpoint: `http://127.0.0.1:${address.port}/mcp`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe.runIf(enabled)('namespace disclosure matched real-model qualification', () => {
  it('measures read, approved mutation, and a tool-free greeting', async () => {
    const account = await createAccount('disclosure-measure');
    const mcp = await fixture();
    const events = await listenEvents(account.cookie);
    await insertDocRow('connections', account.userId, { id: 'con-notes-bench', kind: 'mcp', name: 'Notes', status: 'connected', enabled: true, permission: 'full', endpoint: mcp.endpoint, transport: 'http', createdAt: AT });
    const agentId: string = (await defaultAgent(account)).id;
    const skill = await account.api('POST', '/v1/skills', { name: 'Meeting code briefing', description: 'Retrieve a fresh meeting code from Notes and format a short briefing.', instructions: 'For a meeting code briefing, search the live Notes app for the current meeting code, then reply CODE=<the actual code>. Never invent the code or reuse an old one.', deps: [] });
    expect(skill.status).toBe(201);
    const skillId: string = skill.body.id;
    try {
      const cases = [
        { kind: 'read', text: 'Use the connected Notes app to retrieve the current meeting code from saved notes. You must search the current notes, then return the code.', expected: 'search_notes' },
        { kind: 'action', text: 'Use the connected Notes app to create a note titled Bench Groceries with body milk, eggs. Search for an existing note first. Use the approval card when needed.', expected: 'create_note' },
        { kind: 'greeting', text: 'Hi', expected: undefined },
        ...(selectedChineseScenario() ? [{ kind: 'read-zh', text: '请从已连接的 Notes 应用里查我保存的笔记，找出当前的会议代码。必须实际搜索笔记后再回答，不要猜。', expected: 'search_notes' }] : []),
        { kind: 'skill', text: 'Use my selected Meeting code briefing skill to retrieve the current meeting code from Notes and prepare the briefing. Read the skill instructions first.', expected: 'search_notes' },
      ];
      const selectedScenarios = process.env['E2E_DISCLOSURE_SCENARIOS']?.split(',');
      for (const scenario of cases) {
        if (selectedScenarios && !selectedScenarios.includes(scenario.kind)) continue;
        if (scenario.kind === 'skill') expect((await account.api('PATCH', `/v1/agents/${agentId}`, { skillIds: [skillId] })).status).toBe(200);
        const count = ['greeting', 'skill', 'read-zh'].includes(scenario.kind) ? 1 : repeats;
        for (let repeat = 0; repeat < count; repeat += 1) {
          const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
          expect(chat.status).toBe(201);
          const conversationId: string = chat.body.id;
          const before = mcp.received.length;
          const metricBefore = (await metrics()).length;
          const started = performance.now();
          expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: scenario.text }))).status).toBe(202);
          let finished: Record<string, unknown> | undefined;
          let approvalCount = 0;
          const resolved = new Set<string>();
          const deadline = Date.now() + 180_000;
          while (!finished && Date.now() < deadline) {
            const pending = await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending&kind=approval`);
            const requests: unknown = pending.body?.items;
            if (Array.isArray(requests)) for (const request of requests) {
              if (!isRecord(request) || typeof request['id'] !== 'string' || resolved.has(request['id'])) continue;
              expect(mcp.received.slice(before).filter((call) => call.name === 'create_note')).toHaveLength(0);
              resolved.add(request['id']);
              approvalCount += 1;
              expect((await account.api('POST', `/v1/requests/${request['id']}/resolve`, { action: 'approve' })).status).toBe(200);
            }
            for (const event of events.events) {
              const data: unknown = event.data;
              if (!isRecord(data) || data['type'] !== 'RUN_FINISHED' || !isRecord(data['run'])) continue;
              if (data['run']['conversationId'] === conversationId) finished = data['run'];
            }
            if (!finished) await new Promise((resolve) => setTimeout(resolve, 150));
          }
          expect(finished, `${scenario.kind} did not finish`).toBeDefined();
          const runId = typeof finished?.['id'] === 'string' ? finished['id'] : '';
          expect(finished?.['status'], await runReport(account, runId)).toBe('completed');
          const elapsedMs = Math.round(performance.now() - started);
          const calls = mcp.received.slice(before);
          if (scenario.expected) expect(calls.map((call) => call.name)).toContain(scenario.expected);
          if (scenario.kind === 'action') expect(approvalCount).toBeGreaterThan(0);
          if (scenario.kind === 'greeting') expect(calls).toHaveLength(0);
          const activity = await toolActivity(`${agentId}:${conversationId}`);
          if (scenario.kind === 'skill') expect(activity.calls.map((call) => call.name)).toContain('skill_read');
          const transcripts = await queryStack('select doc from transcripts where kind = ? order by at', [`${agentId}:${conversationId}`]);
          let modelCalls = 0; let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0;
          for (const row of transcripts) {
            const doc: unknown = typeof row['doc'] === 'string' ? JSON.parse(row['doc']) : row['doc'];
            if (!isRecord(doc) || !isRecord(doc['message']) || doc['message']['role'] !== 'assistant') continue;
            const usage = doc['message']['usage'];
            if (!isRecord(usage)) continue;
            modelCalls += 1;
            input += typeof usage['input'] === 'number' ? usage['input'] : 0;
            output += typeof usage['output'] === 'number' ? usage['output'] : 0;
            cacheRead += typeof usage['cacheRead'] === 'number' ? usage['cacheRead'] : 0;
            cacheWrite += typeof usage['cacheWrite'] === 'number' ? usage['cacheWrite'] : 0;
          }
          const detail = await account.api('GET', `/v1/runs/${runId}`);
          const session = 'juno-' + createHash('sha256').update(`${agentId}:${conversationId}`).digest('hex').slice(0, 32);
          const stateHash = (kind: string, query: string): string => createHash('sha256').update(('User request for ' + kind + ' search: ' + query).slice(0, 2000)).digest('hex');
          const decisionStateHashes = new Set([stateHash('discovery', scenario.text)]);
          for (const call of activity.calls) {
            const query = call.arguments['query'];
            if (typeof query !== 'string') continue;
            if (call.name === 'tool_search') decisionStateHashes.add(stateHash('tool', query));
            if (call.name === 'skill_search') decisionStateHashes.add(stateHash('skill', query));
          }
          const intervalMetrics = (await metrics()).slice(metricBefore);
          const attributedMetrics = intervalMetrics.filter((entry) => {
            if (!isRecord(entry)) return false;
            if (entry['session'] === session) return true;
            return entry['kind'] === 'jev' && entry['session'] == null && typeof entry['stateHash'] === 'string' && decisionStateHashes.has(entry['stateHash']);
          });
          if (process.env['E2E_DISCLOSURE_REQUIRE_TRACE'] === '1') {
            const requestId = 'juno-' + createHash('sha256').update(runId).digest('hex').slice(0, 32);
            for (const entry of attributedMetrics) {
              if (!isRecord(entry) || entry['kind'] !== 'jev') continue;
              expect(entry['session'], 'native decision has the task session hash').toBe(session);
              expect(entry['request'], 'native decision has the task run hash').toBe(requestId);
            }
          }
          record({ mode: process.env['E2E_DISCLOSURE_LABEL'], scenario: scenario.kind, repeat, elapsedMs,
            firstMcpMs: calls[0] === undefined ? null : Math.round(calls[0].at - started), modelCalls, session, model: process.env['E2E_REAL_MODEL'], phase: process.env['E2E_DISCLOSURE_PHASE'],
            preselectionStateHash: stateHash('discovery', scenario.text), decisionStateHashes: [...decisionStateHashes],
            tokens: { input, output, cacheRead, cacheWrite }, usage: detail.body?.usage,
            tools: activity.calls.map((call) => call.name), toolErrorCount: activity.results.filter((result) => result.isError).length,
            toolErrors: activity.results.filter((result) => result.isError).map((result) => ({ name: result.toolName, text: result.text.slice(0, 500) })), approvals: approvalCount,
            metrics: attributedMetrics, excludedMetricCount: intervalMetrics.length - attributedMetrics.length });
        }
      }
    } finally { events.close(); await mcp.close(); }
  }, 900_000);
});
