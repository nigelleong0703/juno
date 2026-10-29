import { aguiInput } from '../../agui-input.js';
/**
 * Test-side helpers that drive the stack like a real user: only the public API (account auth under
 * /auth, the /v1 surface and the /v1/events SSE stream) plus the scripted-model file.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { inject } from 'vitest';
import postgres from 'postgres';
import type { DeviceAction, DeviceDeclaration } from 'juno-link/protocol';
import { CORE_TOOL_NAMES } from '../../../packages/juno-agent/src/modules/tools/tools/namespaceDirectory';

export interface ScriptedTurn {
  matchLastText?: string;
  /** With matchLastText: play as the call number `step` (0 = first) since the last user message, wherever the context stands. */
  step?: number;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

/**
 * One scripted tool call the way production reaches it: the model sees only a small fixed core tool set,
 * so a core tool is called directly and every other tool goes through `tool_call { name, arguments }`
 * (the model reply is unwrapped to the inner tool where it is received, the scripted model does the same, so policy,
 * approval and the step row carry the inner name). The core list is the one the harness itself uses.
 */
export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): NonNullable<ScriptedTurn['toolCalls']>[number] {
  return CORE_TOOL_NAMES.includes(name) ? { id, name, arguments: args } : { id, name: 'tool_call', arguments: { name, arguments: args } };
}

/**
 * What a test Mac declares when it joins (a Mac without a declaration is refused). Defaults to files and shell: the
 * permissions the desktop app asks the user for (Screen Recording, Accessibility, the Chrome extension) are not granted.
 * `redeclare` after changing the returned object's `actions` plays the user granting one later.
 */
export function macDevice(actions: DeviceAction[] = ['files', 'shell']): DeviceDeclaration {
  return { deviceId: 'e2e-mac', name: 'E2E Mac', osVersion: 'macOS 15.2', actions };
}

/** Fixed reply of the scripted model for a session key that has no script yet. */
export const SCRIPTED_DEFAULT_REPLY = 'I am operating with the scripted model for testing.';

export const stackUrls = () => inject('e2e');

/** Better Auth rejects cookie-bearing POSTs without a matching Origin, so every request sends it. */
function baseHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = { Origin: stackUrls().apiUrl };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

function cookieFrom(res: Response): string {
  return res
    .headers.getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ');
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Raw request against the public API; `cookie` is optional so unauthenticated calls are testable. */
export async function request<T = any>(method: string, path: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}): Promise<ApiResult<T>> {
  const headers = { ...baseHeaders(cookie), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(stackUrls().apiUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await readBody(res) };
}

export interface AuthResult {
  status: number;
  cookie: string;
  userId: string | undefined;
}

async function authCall(path: string, payload: Record<string, unknown>): Promise<AuthResult> {
  const res = await fetch(stackUrls().apiUrl + path, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readBody(res);
  return { status: res.status, cookie: cookieFrom(res), userId: body?.user?.id };
}

export function signUp(email: string, password: string, name = 'E2E User'): Promise<AuthResult> {
  return authCall('/auth/sign-up/email', { email, password, name });
}

export function signIn(email: string, password: string): Promise<AuthResult> {
  return authCall('/auth/sign-in/email', { email, password });
}

export function signOut(cookie: string): Promise<ApiResult> {
  return request('POST', '/auth/sign-out', {}, cookie);
}

export function getSession(cookie: string): Promise<ApiResult> {
  return request('GET', '/auth/get-session', undefined, cookie);
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@e2e.test`;
}

export interface Account {
  email: string;
  password: string;
  userId: string;
  cookie: string;
  /** Authenticated call against the public API as this account. */
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<ApiResult<T>>;
}

/** Sign up a fresh account (isolated data per scenario) and return its session helpers. */
export async function createAccount(prefix = 'user', name?: string): Promise<Account> {
  const email = uniqueEmail(prefix);
  const password = 'e2e-password-1234';
  const res = await signUp(email, password, name);
  if (res.status !== 200 || !res.cookie || !res.userId) {
    throw new Error(`sign-up failed: status ${res.status}, cookie ${res.cookie ? 'set' : 'missing'}`);
  }
  const cookie = res.cookie;
  return {
    email,
    password,
    userId: res.userId,
    cookie,
    api: (method, path, body) => request(method, path, body, cookie),
  };
}

/**
 * The agent every new account gets at sign-up (named "Juno"). Agent names are unique per owner (409 AGENT_NAME_TAKEN), so a test that
 * only needs "an agent" uses this one instead of creating a second "Juno"; one that needs more agents gives them other names.
 */
export async function defaultAgent(account: Account): Promise<{ id: string; name: string }> {
  const listed = await account.api('GET', '/v1/agents');
  const found = (listed.body?.items as Array<{ id: string; name: string }> | undefined)?.find((agent) => agent.name === 'Juno');
  if (listed.status !== 200 || found === undefined) throw new Error('the sign-up default agent is missing: ' + JSON.stringify(listed.body));
  return found;
}

// ------------------------------------------------------------------ SSE

export interface SseEvent {
  id: number;
  /** SSE event name (`delta` for streaming preview frames, otherwise the event type). */
  name: string;
  /** Parsed event payload; always carries `type`. */
  data: any;
}

export interface EventListener {
  events: SseEvent[];
  /** Resolves with the first event (already received or future) matching the predicate. */
  waitFor(predicate: (event: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): void;
}

function parseFrame(frame: string): SseEvent | undefined {
  let id = 0;
  let name = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  try {
    return { id, name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return undefined;
  }
}

/**
 * Wait until every run seen so far in a conversation has finished. A scripted session indexes its script by the assistant
 * turns the transcript holds, and a message sent while a run is still in its last model call is steered into that run and
 * drops the call's turn: a scenario that sends the next message right after its tool-activity wait must settle first.
 */
export async function waitForIdle(events: EventListener, conversationId: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const started = events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId).map((e) => e.data.metadata.juno.run.id as string);
    // An interrupt outcome only ends a wire segment (the run waits for a decision): not finished.
    const finished = new Set(events.events.filter((e) => (e.data.type === 'RUN_FINISHED' && e.data.outcome?.type !== 'interrupt') || e.data.type === 'RUN_ERROR').map((e) => e.data.metadata.juno.run.id as string));
    if (started.every((id) => finished.has(id))) return;
    if (Date.now() > end) throw new Error('runs still active in ' + conversationId + ': ' + started.filter((id) => !finished.has(id)).join(', '));
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Open GET /v1/events as this account and collect every event until `close()`. `client` names the app (`x-juno-client`, e.g. `ios` for a fake phone).
 * `lastEventId` is a reconnect: the stream replays the durable rows after that cursor, then the synthesized snapshots (frames without an id).
 */
export async function listenEvents(cookie: string, client?: string, lastEventId?: number): Promise<EventListener> {
  const controller = new AbortController();
  const res = await fetch(stackUrls().apiUrl + '/v1/events', {
    headers: { ...baseHeaders(cookie), Accept: 'text/event-stream', ...(client === undefined ? {} : { 'x-juno-client': client }), ...(lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) }) },
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) throw new Error(`/v1/events returned ${res.status}`);

  const events: SseEvent[] = [];
  const waiters = new Set<() => void>();
  const notify = () => waiters.forEach((wake) => wake());

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const event = parseFrame(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          if (event) events.push(event);
          cut = buffer.indexOf('\n\n');
        }
        notify();
      }
    } catch {
      // aborted by close()
    }
  })();

  return {
    events,
    close: () => controller.abort(),
    waitFor(predicate, timeoutMs = 20_000) {
      return new Promise<SseEvent>((resolve, reject) => {
        const check = (): boolean => {
          const hit = events.find(predicate);
          if (!hit) return false;
          cleanup();
          resolve(hit);
          return true;
        };
        const wake = () => void check();
        const timer = setTimeout(() => {
          cleanup();
          const seen = events.map((e) => e.data?.type).join(', ');
          reject(new Error(`timed out after ${timeoutMs}ms waiting for SSE event; saw: [${seen}]`));
        }, timeoutMs);
        function cleanup() {
          clearTimeout(timer);
          waiters.delete(wake);
        }
        waiters.add(wake);
        check();
      });
    },
  };
}

// ------------------------------------------------------------------ scripted model

/**
 * Set the scripted turns for one session (`${agentId}:${conversationId}`). The agent process re-reads
 * the file on every model call; the write is atomic so it never sees a half-written file.
 *
 * The turn used is indexed by how many assistant turns the transcript already holds, so a session
 * that already got a reply needs a leading filler turn to line the script up.
 */
export function scriptModel(sessionKey: string, turns: ScriptedTurn[]): void {
  const file = stackUrls().scriptFile;
  // Scenario files run in parallel workers and share this one file: the read-modify-write is guarded by a lock directory.
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    let scripts: Record<string, ScriptedTurn[]> = {};
    try {
      scripts = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      scripts = {};
    }
    scripts[sessionKey] = turns;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(scripts));
    renameSync(tmp, file);
  } finally {
    rmdirSync(lock);
  }
}

/**
 * Open a direct chat with no first message, script the agent's turns for it, then send the first
 * message. Use this whenever a scenario must control the very first turn (e.g. a tool call): the
 * session key only exists after the conversation is created.
 */
export async function scriptedChat(account: Account, agentId: string, turns: ScriptedTurn[], firstText: string): Promise<{ conversationId: string; sessionKey: string }> {
  const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
  if (created.status !== 201) throw new Error(`create conversation failed: ${created.status} ${JSON.stringify(created.body)}`);
  const conversationId: string = created.body.id;
  const sessionKey = `${agentId}:${conversationId}`;
  scriptModel(sessionKey, turns);
  const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: firstText }));
  if (sent.status !== 202) throw new Error(`send failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  return { conversationId, sessionKey };
}

/** The transcript docs of one session (`${agentId}:${conversationId}`), oldest first. */
async function transcriptDocs(sessionKey: string): Promise<Array<{ message: { role: string; content: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown; usage?: unknown } }>> {
  const sql = postgres(stackUrls().databaseUrl, { max: 1 });
  try {
    const rows = await sql<Array<{ doc: { message: { role: string; content: unknown } } }>>`
      SELECT doc FROM transcripts WHERE doc->>'sessionKey' = ${sessionKey} ORDER BY (doc->>'seq')::int`;
    return rows.map((row) => row.doc);
  } finally {
    await sql.end();
  }
}

/**
 * The model-facing transcript of one session (`${agentId}:${conversationId}`), oldest first, read from
 * the isolated stack's Postgres. Use it to prove what a run actually received (e.g. a task_done).
 */
export async function transcriptTexts(sessionKey: string): Promise<string[]> {
  return (await transcriptDocs(sessionKey)).map((doc) => (typeof doc.message.content === 'string' ? doc.message.content : JSON.stringify(doc.message.content)));
}

/** Poll a session transcript until the predicate holds (completions arrive asynchronously). */
export async function waitForTranscript(sessionKey: string, ok: (messages: string[]) => boolean, timeoutMs = 45_000): Promise<string[]> {
  const end = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < end) {
    last = await transcriptTexts(sessionKey);
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('transcript condition not met; last transcript: ' + JSON.stringify(last).slice(0, 1500));
}

/** Rows of `table` whose document text contains `needle` (to prove file bytes never reach Postgres). */
export async function docRowsContaining(table: string, needle: string): Promise<number> {
  const sql = postgres(stackUrls().databaseUrl, { max: 1 });
  try {
    const [row] = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM ${sql(table)} WHERE strpos(doc::text, ${needle}) > 0`;
    return Number(row?.count ?? 0);
  } finally {
    await sql.end();
  }
}

/** Insert a document row straight into the isolated stack's Postgres (for states the API cannot create, e.g. an orphaned run). */
export async function insertDocRow(table: string, ownerId: string, doc: Record<string, unknown> & { id: string }, index: { agentId?: string; conversationId?: string; status?: string; kind?: string } = {}): Promise<void> {
  const sql = postgres(stackUrls().databaseUrl, { max: 1 });
  try {
    const full = { ...doc, ownerId };
    // `at` (the time-ordered column) comes from the doc's own `at`, so a seeded old row sorts like a real one.
    const at = typeof doc['at'] === 'string' ? doc['at'] : null;
    await sql`INSERT INTO ${sql(table)} (id, owner_id, agent_id, conversation_id, status, kind, at, doc)
      VALUES (${doc.id}, ${ownerId}, ${index.agentId ?? null}, ${index.conversationId ?? null}, ${index.status ?? null}, ${index.kind ?? null}, ${at}, ${sql.json(full as never)})`;
  } finally {
    await sql.end();
  }
}

/** The model transcript with roles, oldest first (use it when the speaker matters, e.g. "the agent replied after X"). */
export async function transcriptMessages(sessionKey: string): Promise<Array<{ role: string; text: string }>> {
  return (await transcriptDocs(sessionKey)).map((doc) => ({ role: doc.message.role, text: typeof doc.message.content === 'string' ? doc.message.content : JSON.stringify(doc.message.content) }));
}

export interface ToolActivity {
  /** Tool calls the model made in this session, oldest first. */
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Tool results the harness fed back, oldest first. */
  results: Array<{ toolName: string; isError: boolean; text: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which tools the model called in one session and what each returned (real-model scenarios assert on this, never on wording).
 * `calls` are the calls as the model made them (a hidden tool shows as `tool_call`); a result carries the name of the tool that
 * actually ran, so a proxied call is found by its inner tool name like the step row and the policy see it.
 */
export async function toolActivity(sessionKey: string): Promise<ToolActivity> {
  const activity: ToolActivity = { calls: [], results: [] };
  const proxied = new Map<string, string>();
  for (const doc of await transcriptDocs(sessionKey)) {
    const message = doc.message;
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    if (message['role'] === 'assistant') {
      for (const part of message['content']) {
        if (isRecord(part) && part['type'] === 'toolCall' && typeof part['name'] === 'string') {
          const args = isRecord(part['arguments']) ? part['arguments'] : {};
          activity.calls.push({ name: part['name'], arguments: args });
          if (part['name'] === 'tool_call' && typeof args['name'] === 'string' && typeof part['id'] === 'string') proxied.set(part['id'], args['name']);
        }
      }
    } else if (message['role'] === 'toolResult') {
      const text = message['content'].map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join('');
      const callId = message['toolCallId'];
      activity.results.push({ toolName: (typeof callId === 'string' ? proxied.get(callId) : undefined) ?? String(message['toolName']), isError: message['isError'] === true, text });
    }
  }
  return activity;
}

/**
 * What each model call of one session cost, oldest first (the usage the provider reported, kept on the stored assistant message):
 * `input` is the uncached part of the request, `cacheRead` the cached part, `tools` the names of the tools it called.
 */
export async function modelUsage(sessionKey: string): Promise<Array<{ input: number; cacheRead: number; cacheWrite: number; tools: string[] }>> {
  const calls: Array<{ input: number; cacheRead: number; cacheWrite: number; tools: string[] }> = [];
  for (const { message } of await transcriptDocs(sessionKey)) {
    const usage = message.usage;
    if (message.role !== 'assistant' || !isRecord(usage) || !Array.isArray(message.content)) continue;
    const count = (key: string): number => (typeof usage[key] === 'number' ? usage[key] : 0);
    calls.push({
      input: count('input'), cacheRead: count('cacheRead'), cacheWrite: count('cacheWrite'),
      tools: message.content.flatMap((part) => (isRecord(part) && part['type'] === 'toolCall' && typeof part['name'] === 'string' ? [part['name']] : [])),
    });
  }
  return calls;
}

/** The transcript is flushed shortly after a run ends: poll until the predicate holds (or fail with the last activity). */
export async function waitForToolActivity(sessionKey: string, ok: (activity: ToolActivity) => boolean, timeoutMs = 30_000): Promise<ToolActivity> {
  const end = Date.now() + timeoutMs;
  let last = await toolActivity(sessionKey);
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    last = await toolActivity(sessionKey);
  }
  if (!ok(last)) {
    const transcript = (await transcriptDocs(sessionKey)).map((d) => d.message.role + ':' + JSON.stringify(d.message.content).slice(0, 90)).join('\n');
    throw new Error('tool activity condition not met for ' + sessionKey + '; last: ' + JSON.stringify(last).slice(0, 1500) + '\nTRANSCRIPT:\n' + transcript);
  }
  return last;
}

/** How many times the scripted model was called for one session (it logs every call beside the script file). */
export function modelCalls(sessionKey: string): number {
  try {
    return readFileSync(stackUrls().scriptFile + '.tools.jsonl', 'utf8').split('\n').filter(Boolean).filter((line) => (JSON.parse(line) as { sessionKey: string }).sessionKey === sessionKey).length;
  } catch {
    return 0;
  }
}

/** sha256 of every image the scripted model received on its latest call for one session. */
export function lastModelImages(sessionKey: string): string[] {
  const calls = readFileSync(stackUrls().scriptFile + '.tools.jsonl', 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { sessionKey: string; images?: string[] }).filter((call) => call.sessionKey === sessionKey);
  return calls.at(-1)?.images ?? [];
}

/** The client's typing ping (the apps send `true` at most once a second while composing, `false` on send/clear/blur). */
export function typingPing(account: Account, conversationId: string, active: boolean): Promise<ApiResult> {
  return account.api('POST', `/v1/conversations/${conversationId}/typing`, { active });
}

/** Session key of a child task run: `${agentId}:${conversationId}::child:${runId}`. */
export function childSessionKey(agentId: string, conversationId: string, runId: string): string {
  return `${agentId}:${conversationId}::child:${runId}`;
}

export interface RunRow {
  id: string;
  agentId: string;
  parentRunId?: string;
  status: string;
  childResult?: string;
}

export interface ItemRow {
  id: string;
  type: string;
  agentId?: string;
  runId?: string;
  markdown?: string;
}

function rows<T>(body: unknown, what: string, keep: (row: Record<string, unknown>) => T | undefined): T[] {
  const items = isRecord(body) && Array.isArray(body['items']) ? body['items'] : undefined;
  if (items === undefined) throw new Error(`${what}: no items in ${JSON.stringify(body).slice(0, 300)}`);
  const out: T[] = [];
  for (const item of items) {
    const row = isRecord(item) ? keep(item) : undefined;
    if (row !== undefined) out.push(row);
  }
  return out;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Every run of a conversation (all agents, children included), read through the public API. */
export async function listRuns(account: Account, conversationId: string): Promise<RunRow[]> {
  const res = await account.api('GET', `/v1/runs?conversationId=${conversationId}&limit=100`);
  if (res.status !== 200) throw new Error(`list runs failed: ${res.status} ${JSON.stringify(res.body)}`);
  return rows(res.body, 'list runs', (r) => {
    const id = text(r['id']);
    const agentId = text(r['agentId']);
    const status = text(r['status']);
    if (id === undefined || agentId === undefined || status === undefined) return undefined;
    const parentRunId = text(r['parentRunId']);
    const childResult = text(r['childResult']);
    return { id, agentId, status, ...(parentRunId === undefined ? {} : { parentRunId }), ...(childResult === undefined ? {} : { childResult }) };
  });
}

/** One-line account of a run (status, error, step list) to use as an assertion message when a run ends badly. */
export async function runReport(account: Account, runId: string): Promise<string> {
  const run = await account.api('GET', `/v1/runs/${runId}`);
  const stepRows = await account.api('GET', `/v1/runs/${runId}/steps`);
  const steps = Array.isArray(stepRows.body?.items) ? stepRows.body.items.map((s: { verb: string; target: string; status: string }) => `${s.verb} ${s.target} [${s.status}]`) : [];
  return JSON.stringify({ runId, status: run.body?.status, error: run.body?.error, steps });
}

/**
 * Print what happened in a real-model chat when a test fails: the chat items, the tool calls with arguments and results, and the
 * approval requests. Call it from a catch block, then rethrow; keeps product logs free of arguments and text.
 */
export async function diagnose(label: string, account: Account, conversationId: string, sessionKey: string): Promise<void> {
  const short = (value: unknown, max = 600): string => { const s = typeof value === 'string' ? value : JSON.stringify(value); return s.length > max ? s.slice(0, max) + '...' : s; };
  const items = await listItems(account, conversationId).catch(() => []);
  console.error(`[${label}] chat`, short(items.map((item) => [item.type, item.runId?.slice(-6), item.markdown ?? '']), 4000));
  const activity = await toolActivity(sessionKey).catch(() => undefined);
  if (activity) {
    for (const call of activity.calls) console.error(`[${label}] call ${call.name}`, short(call.arguments));
    for (const result of activity.results) console.error(`[${label}] result ${result.toolName}${result.isError ? ' ERROR' : ''}`, short(result.text, 400));
  }
  const requests = await account.api('GET', '/v1/requests').catch(() => undefined);
  if (requests) console.error(`[${label}] requests`, short(requests.body?.items ?? requests.body, 1500));
}

/** Every item of a conversation, oldest first, read through the public API. */
export async function listItems(account: Account, conversationId: string): Promise<ItemRow[]> {
  const res = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
  if (res.status !== 200) throw new Error(`list items failed: ${res.status} ${JSON.stringify(res.body)}`);
  return rows(res.body, 'list items', (r) => {
    const id = text(r['id']);
    const type = text(r['type']);
    if (id === undefined || type === undefined) return undefined;
    const agentId = text(r['agentId']);
    const runId = text(r['runId']);
    const markdown = text(r['markdown']);
    return { id, type, ...(agentId === undefined ? {} : { agentId }), ...(runId === undefined ? {} : { runId }), ...(markdown === undefined ? {} : { markdown }) };
  });
}

/** Rows of a query on the stack's Postgres (`?` placeholders, numbered for the driver). */
export async function queryStack(text: string, params: Array<string | number> = []): Promise<Array<Record<string, unknown>>> {
  const sql = postgres(stackUrls().databaseUrl, { max: 1 });
  try {
    let n = 0;
    return (await sql.unsafe(text.replace(/\?/g, () => '$' + String(++n)), params)).map((row) => ({ ...row }));
  } finally {
    await sql.end();
  }
}

/** A write on the stack's database, for scenarios that must damage durable state on purpose. */
export async function execStack(text: string, params: Array<string | number> = []): Promise<void> {
  await queryStack(text, params);
}

/** Runs the chat digest of every conversation of the account now (in a live stack the quiet window does it); the outcomes, comma-separated. */
export async function runChatDigests(account: Account, agentId: string): Promise<{ outcome: string }> {
  const listed = await account.api('GET', '/v1/conversations?limit=100');
  const ids = ((listed.body?.items ?? []) as Array<{ id: string }>).map((conversation) => conversation.id);
  const outcomes: string[] = [];
  for (const conversationId of ids) outcomes.push((await runNow('ChatDigest', conversationId, account.userId, { ownerId: account.userId, agentId, conversationId })).outcome);
  return { outcome: outcomes.join(',') };
}

/** Run a timer job now through agentd's internal run-now route (the scheduler would run it later); returns its answer. */
export async function runNow(service: 'MemoryTimer' | 'IdeasTimer' | 'ChatDigest' | 'Session', key: string, ownerId: string, input?: unknown): Promise<{ outcome: string }> {
  const { agentdUrl, internalToken } = stackUrls();
  const res = await fetch(`${agentdUrl}/v1/internal/run-now/${service}/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken}`, 'x-owner-id': ownerId },
    body: JSON.stringify(input ?? {}),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`runNow ${service} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Crash-restart agentd (SIGKILL) and wait until it serves again; in-flight runs must resume from the runner's journal. */
export async function restartAgentd(): Promise<void> {
  const res = await fetch(stackUrls().controlUrl + '/restart/agentd', { method: 'POST' });
  if (!res.ok) throw new Error('agentd restart failed: ' + (await res.text()));
}

/** One execution worker process of the split stack (E2E_WORKERS); `id` is the owner name written into its lease rows. */
export interface WorkerProcess { index: number; id: string; pid: number | null; alive: boolean }

async function control<T>(method: string, path: string): Promise<T> {
  const res = await fetch(stackUrls().controlUrl + path, { method });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const stackWorkers = (): Promise<WorkerProcess[]> => control('GET', '/workers');
/** SIGKILL a worker (a power cut for that process only); returns its pid. */
export const killWorker = async (index: number): Promise<number | undefined> => (await control<{ pid?: number }>('POST', `/workers/${String(index)}/kill`)).pid;
/** `concurrency` bounds how many invocations the worker holds at once (default: unbounded); 1 makes it refuse a second claim while it holds one. */
export const startWorker = async (index: number, concurrency?: number): Promise<void> => { await control('POST', `/workers/${String(index)}/start${concurrency === undefined ? '' : `?concurrency=${String(concurrency)}`}`); };
/** Freeze (SIGSTOP) or thaw (SIGCONT) a worker without killing it: its leases expire while it cannot renew them. */
export const signalWorker = async (index: number, name: 'SIGSTOP' | 'SIGCONT'): Promise<void> => { await control('POST', `/workers/${String(index)}/signal?name=${name}`); };
/** Start a second coordinator against the same database; it must wait on the instance lock. */
export const startSecondCoordinator = (): Promise<{ pid: number; port: number; logFile: string }> => control('POST', '/coordinator/second');
export const stopSecondCoordinator = async (): Promise<void> => { await control('DELETE', '/coordinator/second'); };

/** A request to the api port with an explicit Host header: the api routes artifact pages and Spaces by Host, and Node does not resolve *.localhost. */
export function hostRequest(host: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const target = new URL(stackUrls().apiUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: target.hostname, port: target.port, path, method: options.method ?? 'GET', headers: { host, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`${options.method ?? 'GET'} ${path} timed out`)));
    req.end(options.body);
  });
}
