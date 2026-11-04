import { aguiInput } from '../../agui-input.js';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runReport, toolActivity, type Account, type EventListener } from '../harness/client';

/**
 * Run-speed benchmark (M-SPEED). Opt-in: E2E_SPEED_BENCH=1, E2E_SPEED_REPEATS=3, E2E_SPEED_REPORT=<jsonl path>.
 * Sends fixed chat prompts to the real model and prints, per run: wall time, first visible text, model calls, input tokens per call,
 * cache-read fraction per call and the harness/other milliseconds of every step, taken from the agentd `model call` / `step timing` log lines.
 * Needs a (fake) search key so web_search is in the tool list like on the live stack: E2E_SEARCH_PROVIDER=exa E2E_SEARCH_API_KEY=bench.
 */
const enabled = process.env['E2E_SPEED_BENCH'] === '1';
const repeats = Number(process.env['E2E_SPEED_REPEATS'] ?? '1');
const logDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.data', 'e2e', 'logs');

interface Prompt { id: string; text: string; /** Reuse the conversation of an earlier prompt (a second turn). */ after?: string }
const PROMPTS: Prompt[] = [
  { id: 'simple', text: 'Reply with one short sentence: what is 2 + 3?' },
  { id: 'memory', text: 'What do you remember about me and what I like? Check your memory before answering.' },
  { id: 'one-tool', text: 'Look up my current plan for today in my tasks and tell me in one line what is on it.' },
  { id: 'web', text: 'Search the web for the latest stable Node.js release and tell me the version number.' },
  { id: 'two-lookups', text: 'Do two independent web searches at the same time: the current weather in Paris, and the population of Canada. Then give me both answers in two lines.' },
  { id: 'followup', text: 'Now multiply that answer by 7. Just the number.', after: 'simple' },
  // Not in the default set: the cache check for a run whose history holds screenshots (E2E_SPEED_PROMPTS=screens).
  { id: 'screens', text: 'Take a screenshot of the computer screen, then wait a moment and take a second screenshot, then a third, and tell me in one line what changed.' },
  // A task that needs the browser tools (they are found through tool_search, not declared up front).
  { id: 'browser', text: 'Use the computer browser to open https://example.com, read the page text, and tell me its heading in one line.' },
  // Not in the default set (E2E_SPEED_PROMPTS=ticket): the owner's slow ticket lookup, search-only (nothing is bought).
  { id: 'ticket', text: "Find the cheapest ticket price for LANY's Singapore concert on Nov 4 and tell me where the price comes from. Don't buy anything." },
  { id: 'children', text: 'Start two helper tasks at the same time: one finds the capital of France, the other the capital of Japan. When both are back, give me both in one line.' },
];
const only = process.env['E2E_SPEED_PROMPTS']?.split(',');
const selected = (id: string): boolean => (only === undefined ? id !== 'screens' && id !== 'children' && id !== 'browser' && id !== 'ticket' : only.includes(id));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

function logLines(): Array<Record<string, unknown>> {
  if (!existsSync(logDir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(logDir)) {
    if (!file.endsWith('.log') || file.startsWith('postgres')) continue;
    for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
      if (!line.includes('"model call"') && !line.includes('"step timing"')) continue;
      try { const parsed: unknown = JSON.parse(line); if (isRecord(parsed)) out.push(parsed); } catch { /* partial line */ }
    }
  }
  return out;
}

async function sendAndMeasure(account: Account, events: EventListener, conversationId: string, text: string) {
  const startedIndex = events.events.length;
  const t0 = performance.now();
  const posted = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
  expect(posted.status).toBe(202);
  let firstTextMs: number | undefined;
  let finishedMs: number | undefined;
  let lastReplyMs: number | undefined;
  let runId = '';
  let seen = startedIndex;
  const deadline = Date.now() + 200_000;
  while (finishedMs === undefined && Date.now() < deadline) {
    for (; seen < events.events.length; seen += 1) {
      const data: unknown = events.events[seen]?.data;
      if (!isRecord(data)) continue;
      const now = Math.round(performance.now() - t0);
      const metadata = isRecord(data['metadata']) && isRecord(data['metadata']['juno']) ? data['metadata']['juno'] : undefined;
      const run = metadata !== undefined && isRecord(metadata['run']) ? metadata['run'] : undefined;
      if (run !== undefined && run['conversationId'] !== conversationId) continue;
      if (data['type'] === 'RUN_STARTED' && run !== undefined && typeof run['id'] === 'string') runId = run['id'];
      const item = isRecord(data['item']) ? data['item'] : undefined;
      if (data['conversationId'] === conversationId && data['type'] === 'item.added' && item?.['type'] === 'agent_message') { firstTextMs ??= now; lastReplyMs = now; }
      if (data['type'] === 'RUN_FINISHED' && run !== undefined && run['id'] === runId && !isRecord(data['outcome'])) finishedMs = now;
      if (data['type'] === 'RUN_FINISHED' && run !== undefined && run['id'] === runId && isRecord(data['outcome']) && data['outcome']['type'] !== 'interrupt') finishedMs = now;
    }
    if (finishedMs === undefined) await new Promise((r) => setTimeout(r, 20));
  }
  return { runId, wallMs: finishedMs, firstTextMs, lastReplyMs };
}

describe.runIf(enabled)('run speed benchmark', () => {
  it('measures the fixed chat prompts', async () => {
    const output = process.env['E2E_SPEED_REPORT'];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const account = await createAccount('speed');
      const events = await listenEvents(account.cookie);
      try {
        const agentId = (await defaultAgent(account)).id;
        const conversations = new Map<string, string>();
        for (const prompt of PROMPTS.filter((item) => selected(item.id))) {
          let conversationId = prompt.after === undefined ? undefined : conversations.get(prompt.after);
          if (conversationId === undefined) {
            const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
            expect(chat.status).toBe(201);
            conversationId = chat.body.id as string;
          }
          conversations.set(prompt.id, conversationId);
          const measured = await sendAndMeasure(account, events, conversationId, prompt.text);
          // A prompt that needs a real screen can stall on the fake computer: it is recorded as unfinished, not failed.
          if (measured.wallMs === undefined && !['screens', 'browser'].includes(prompt.id)) expect(measured.wallMs, `${prompt.id} did not finish`).toBeDefined();
          await new Promise((r) => setTimeout(r, 1500));
          const tools = (await toolActivity(`${agentId}:${conversationId}`)).calls.map((call) => call.name);
          const lines = logLines().filter((line) => line['runId'] === measured.runId);
          const calls = lines.filter((line) => line['msg'] === 'model call').sort((a, b) => num(a['time']) - num(b['time']));
          const steps = lines.filter((line) => line['msg'] === 'step timing');
          const record = {
            repeat, prompt: prompt.id, runId: measured.runId,
            wallMs: measured.wallMs, firstTextMs: measured.firstTextMs, lastReplyMs: measured.lastReplyMs,
            modelCalls: calls.length, finished: measured.wallMs !== undefined, tools,
            calls: calls.map((c) => ({ step: c['step'], input: num(c['totalInputTokens']), cacheRead: num(c['cachedTokens']), cacheFrac: typeof c['cacheReadFraction'] === 'number' ? Math.round(c['cacheReadFraction'] * 100) : null, ms: c['durationMs'], firstTokenMs: c['firstTokenMs'], toolCount: c['toolCount'], toolHash: c['toolSchemaHash'], sysHash: c['systemPromptHash'], toolCalls: c['toolCalls'], out: c['outputTokens'] })),
            steps: steps.map((s) => ({ wall: s['wallMs'], model: s['modelMs'], tool: s['toolMs'], harness: s['harnessMs'], other: s['otherMs'], top: s['harnessTop'] })),
          };
          console.info('[speed-benchmark]', JSON.stringify(record));
          if (output !== undefined) appendFileSync(output, JSON.stringify(record) + '\n');
          const detail = await account.api('GET', `/v1/runs/${measured.runId}`);
          if (detail.status !== 200) console.info('[speed-benchmark] run detail', detail.status, await runReport(account, measured.runId));
        }
      } finally {
        events.close();
      }
    }
  });
});
