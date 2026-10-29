import { aguiInput } from '../../../agui-input.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createAccount, defaultAgent, hostRequest, listItems, listRuns, runChatDigests, stackUrls, toolActivity, childSessionKey, type Account } from '../../harness/client';
import { decide, type PendingRequest } from './user';
import type { CheckEnv, Interaction, Observed, StepObs, TaskSpec, ToolCallObs, ToolResultObs, TurnObs } from './types';

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled', 'canceled']);

export function checkEnv(account: Account): CheckEnv {
  return {
    api: (method, path, body) => account.api(method, path, body).then((r) => ({ status: r.status, body: r.body })),
    hostRequest: (host, path, options) => hostRequest(host, path, options),
    artifactHost: stackUrls().artifactHost,
    userId: account.userId,
    async runMemoryJob() {
      await runChatDigests(account, (await defaultAgent(account)).id);
    },
  };
}

/** Containers and volumes of one owner, by the label the local provider puts on them: never anything of another owner. */
function ownerResources(ownerId: string): { containers: string[]; volumes: string[] } {
  const label = `label=dev.agent-desktop.owner=${createHash('sha256').update(ownerId).digest('hex')}`;
  const list = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  return { containers: list('ps', '-aq', '--filter', label), volumes: list('volume', 'ls', '-q', '--filter', label) };
}

export function removeOwnerResources(ownerId: string): string[] {
  const { containers, volumes } = ownerResources(ownerId);
  if (containers.length > 0) execFileSync('docker', ['rm', '-f', ...containers], { stdio: 'ignore' });
  if (volumes.length > 0) execFileSync('docker', ['volume', 'rm', '-f', ...volumes], { stdio: 'ignore' });
  return [...containers, ...volumes];
}

async function setUp(account: Account): Promise<{ agentId: string }> {
  // The model comes from E2E_REAL_MODEL; an effort is set on the chat, task and deep tiers only when E2E_REASONING_EFFORT overrides it.
  const model = process.env['E2E_REAL_MODEL'];
  const effort = process.env['E2E_REASONING_EFFORT'];
  if (model !== undefined && model.length > 0) {
    const set = await account.api('PATCH', '/v1/settings', { models: { defaultModel: model, ...(effort ? { tiers: { chat: { effort }, task: { effort }, deep: { effort } } } : {}) } });
    if (set.status !== 200) throw new Error('could not set the model: ' + JSON.stringify(set.body));
  }
  const agent = await defaultAgent(account);
  const computer = await account.api('POST', '/v1/computers/ensure', {});
  if (computer.status >= 300) throw new Error('computer ensure failed: ' + JSON.stringify(computer.body));
  const screen = await account.api('POST', `/v1/computers/${computer.body.id}/screens`, { agentId: agent.id });
  if (screen.status >= 300) throw new Error('screen failed: ' + JSON.stringify(screen.body));
  return { agentId: agent.id };
}

/** Run one case against the stack: send its messages, play the scripted user, and record what really happened. */
export async function runTask(spec: TaskSpec): Promise<{ observed: Observed; env: CheckEnv; account: Account; cleanup: () => string[] }> {
  const started = Date.now();
  const deadline = started + spec.timeoutMs;
  const account = await createAccount('task-' + spec.id.slice(0, 12));
  const env = checkEnv(account);
  const { agentId } = await setUp(account);
  await spec.before?.(env);
  const interactions: Interaction[] = [];
  const seen = new Set<string>();
  const turns: TurnObs[] = [];
  const conversations: string[] = [];
  let conversationId = '';

  /** Answer whatever the agent has asked and not yet had answered. */
  async function servePending(): Promise<void> {
    const pending = await account.api('GET', '/v1/requests?status=pending&limit=50');
    for (const request of (pending.body?.items ?? []) as PendingRequest[]) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      const decision = decide(spec.user, request);
      let res = await account.api('POST', `/v1/requests/${request.id}/resolve`, decision.body);
      if (res.status >= 400 && decision.body.action === 'answer') {
        const retry = { ...decision.body, answers: Object.fromEntries(Object.entries(decision.body.answers ?? {}).map(([k]) => [k, spec.user.fallbackReply])) };
        res = await account.api('POST', `/v1/requests/${request.id}/resolve`, retry);
      }
      interactions.push({ requestId: request.id, at: new Date().toISOString(), ...decision.interaction, ...(res.status >= 400 ? { note: `resolve refused: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}` } : {}) });
    }
  }

  async function waitForRuns(conversation: string): Promise<{ status: string; runIds: string[]; runError?: string }> {
    let quiet = 0;
    for (;;) {
      await servePending();
      const runs = await listRuns(account, conversation);
      const done = runs.length > 0 && runs.every((r) => TERMINAL.has(r.status));
      quiet = done ? quiet + 1 : 0;
      if (quiet >= 2) {
        const top = runs.find((r) => r.parentRunId === undefined) ?? runs[0];
        const error = top === undefined ? undefined : ((await account.api('GET', `/v1/runs/${top.id}`)).body?.error as string | undefined);
        return { status: top?.status ?? 'unknown', runIds: runs.map((r) => r.id), ...(error === undefined ? {} : { runError: error }) };
      }
      if (Date.now() > deadline) return { status: 'timeout', runIds: runs.map((r) => r.id) };
      await sleep(1_500);
    }
  }

  let before = 0;
  for (const [index, turn] of spec.turns.entries()) {
    if (turn.newConversation === true || conversationId === '') {
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId], firstMessage: { text: turn.message } });
      if (created.status !== 201) throw new Error('create conversation failed: ' + JSON.stringify(created.body));
      conversationId = created.body.id as string;
      conversations.push(conversationId);
      before = 0;
    } else {
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: turn.message }));
      if (sent.status !== 202) throw new Error('send message failed: ' + JSON.stringify(sent.body));
    }
    await sleep(2_000);
    const finished = await waitForRuns(conversationId);
    const items = await listItems(account, conversationId);
    const replies = items.filter((i) => i.type === 'agent_message').map((i) => i.markdown ?? '');
    turns.push({ message: turn.message, conversationId, runIds: finished.runIds, status: finished.status, ...(finished.runError === undefined ? {} : { runError: finished.runError }), replies: replies.slice(before) });
    before = replies.length;
    if (turn.afterTurn !== undefined && index < spec.turns.length) await turn.afterTurn(env);
    if (finished.status === 'timeout') break;
  }

  // What really happened: every run's tool calls and results (transcript), steps and cost, children included.
  const calls: ToolCallObs[] = [];
  const results: ToolResultObs[] = [];
  const steps: StepObs[] = [];
  let costUsd = 0;
  let costKnown = true;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const conversation of conversations) {
    const runs = await listRuns(account, conversation);
    const keys = new Map<string, string>([[`${agentId}:${conversation}`, 'main']]);
    for (const run of runs) if (run.parentRunId !== undefined) keys.set(childSessionKey(agentId, conversation, run.id), run.id);
    for (const [key, tag] of keys) {
      let last = await toolActivity(key);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await sleep(1_000);
        const next = await toolActivity(key);
        const stable = next.calls.length === last.calls.length && next.results.length === last.results.length;
        last = next;
        if (stable) break;
      }
      for (const c of last.calls) calls.push({ name: c.name, args: c.arguments, runId: tag });
      for (const r of last.results) results.push({ toolName: r.toolName, isError: r.isError, text: r.text, runId: tag });
    }
    for (const run of runs) {
      const detail = await account.api('GET', `/v1/runs/${run.id}`);
      costUsd += Number(detail.body?.usage?.costUsd ?? 0);
      if (detail.body?.usage?.costKnown !== true) costKnown = false;
      inputTokens += Number(detail.body?.usage?.inputTokens ?? 0);
      outputTokens += Number(detail.body?.usage?.outputTokens ?? 0);
      const stepRows = await account.api('GET', `/v1/runs/${run.id}/steps`);
      for (const s of (stepRows.body?.items ?? []) as Array<{ verb: string; target: string; status: string; startedAt: string; input?: { url?: string }; output?: { url?: string } }>) {
        const url = s.output?.url ?? s.input?.url;
        steps.push({ runId: run.id, verb: s.verb, target: s.target, status: s.status, startedAt: s.startedAt, ...(url === undefined ? {} : { url }) });
      }
    }
  }
  const observed: Observed = { taskId: spec.id, turns, calls, results, steps, interactions, durationMs: Date.now() - started, costUsd, costKnown, inputTokens, outputTokens };
  return { observed, env, account, cleanup: () => removeOwnerResources(account.userId) };
}
