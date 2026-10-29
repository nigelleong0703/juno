/**
 * vitest globalSetup: boots a fully isolated real backend stack and tears it down again.
 *
 * Order: Postgres (embedded) -> migrate -> computerd -> agentd -> api.
 * E2E_WORKERS=N (1..4) splits agentd like production: one `AGENTD_ROLE=coordinator` process (HTTP, lock, platform singletons)
 * plus N `AGENTD_ROLE=worker` processes (separate OS processes, same database); the control server can kill and start them.
 * Everything lives under <repo>/.data/e2e on its own ports (see PORTS), every child gets a clean
 * env built from scratch (never the root .env, never process.env), and nothing here may talk to
 * the live dev stack (Postgres 54330, services 8787/8788/8791).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

/** What scenarios receive through vitest `inject('e2e')`. */
export interface E2eContext {
  /** Where the api and agentd expect Composio (COMPOSIO_BASE_URL); the scenario that needs it listens on this port itself. */
  composioUrl: string;
  /** The Composio key the stack is configured with (what the stand-in checks `x-api-key` against). */
  composioKey: string;
  apiUrl: string;
  agentdUrl: string;
  /** The service bearer of the isolated agentd's internal API (for the run-now route). */
  internalToken: string;
  /** JSON file the scripted model re-reads on every call: { [`${agentId}:${conversationId}`]: ScriptedTurn[] }. */
  scriptFile: string;
  /** The isolated stack's Postgres, for scenarios that must assert durable internal state. */
  databaseUrl: string;
  /** Harness control endpoint (loopback): POST /restart/agentd kills agentd hard and starts it again. */
  controlUrl: string;
  /** computerd, for scenarios that must read the gateway address or pause the computer like the platform would. */
  computerdUrl: string;
  computerdToken: string;
  /** Spaces are served by the api's own port: `spaceUrl` is the api URL and the app's domain is `<spaceId>.<spaceDomain>`; the host header is set by the test. */
  spaceUrl: string;
  spaceDomain: string;
  /** The stack's (test-only) key for Spaces open links and session cookies. */
  spaceUrlSecret: string;
  /** Host that serves published HTML pages (same port as the api, routed by Host). */
  artifactHost: string;
  /** The stack's (test-only) key for artifact render URLs, so a scenario can mint an expired or forged one. */
  artifactUrlSecret: string;
  /** Execution worker processes beside the coordinator (E2E_WORKERS); 0 = one `all`-role agentd. */
  workers: number;
}

declare module 'vitest' {
  export interface ProvidedContext {
    e2e: E2eContext;
  }
}

/**
 * E2E_PORT_OFFSET shifts every port, so two checkouts (worktrees) can run their suites at the same time:
 * e.g. E2E_PORT_OFFSET=100 uses 18887/18888/... Each checkout keeps its own .data/e2e, so stacks never share state.
 */
const PORT_OFFSET = Number(process.env['E2E_PORT_OFFSET'] ?? '0');
if (!Number.isInteger(PORT_OFFSET) || PORT_OFFSET < 0 || PORT_OFFSET > 1000) throw new Error('E2E_PORT_OFFSET must be an integer from 0 to 1000');
const WORKERS = Number(process.env['E2E_WORKERS'] ?? '0');
if (!Number.isInteger(WORKERS) || WORKERS < 0 || WORKERS > 4) throw new Error('E2E_WORKERS must be an integer from 0 to 4');
/** Lease lifetime of the split stack: a killed worker's runs are taken over after this, so the crash scenarios stay short. */
const SPLIT_LEASE_TTL_MS = '6000';
const PORTS = {
  postgres: 54399 + PORT_OFFSET,
  computerd: 18791 + PORT_OFFSET,
  /** The computer link listener of computerd (BACKEND 7.11); no computer dials it with the fake provider. */
  computerdLink: 18795 + PORT_OFFSET,
  /** memoryd, the memory service (BACKEND §2.4): agentd reads and writes memory through it in the e2e stack. */
  memoryd: 18796 + PORT_OFFSET,
  agentd: 18788 + PORT_OFFSET,
  /** The port a second coordinator is asked to use; it must never bind it while the first holds the lock. */
  agentdSecond: 18789 + PORT_OFFSET,
  api: 18787 + PORT_OFFSET,
  /** Composio's stand-in (the scenario that uses it listens here); the stack only points COMPOSIO_BASE_URL at it. */
  composio: 18797 + PORT_OFFSET,
  control: 18799 + PORT_OFFSET,
} as const;
const COMPOSIO_ENV = {
  COMPOSIO_API_KEY: 'e2e-composio-key',
  COMPOSIO_BASE_URL: `http://127.0.0.1:${PORTS.composio}`,
  // Spotify has no Composio-managed OAuth app: the deployment names its own app's auth config.
  COMPOSIO_AUTH_CONFIG_SPOTIFY: 'ac_e2e_spotify',
} as const;

/** Live dev-stack ports. Any env value or argument that mentions one of these aborts the boot. */
const LIVE_PORTS = ['54329', '54330', '8787', '8788', '8791', '8796', '9080', '5199'];

const HEALTH_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 8_000;
const STALE_MARKER = /\.data\/e2e|--e2e-stack/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dataDir = join(repoRoot, '.data', 'e2e');
const pidFile = join(dataDir, 'pids.json');
const logDir = join(dataDir, 'logs');

const SECRETS = {
  internalToken: 'e2e-internal-agentd-token-0123456789',
  // The app catalog admin path (/admin/v1/apps); scenarios/apps.test.ts uses the same value.
  adminToken: 'e2e-admin-token-0123456789',
  computerdToken: 'e2e-computerd-token-0123456789',
  memorydToken: 'e2e-memoryd-token-0123456789',
  screenTicketSecret: 'e2e-screen-ticket-secret-0123456789',
  artifactUrlSecret: 'e2e-artifact-url-secret-0123456789',
  spaceUrlSecret: 'e2e-space-url-secret-0123456789',
  authSecret: 'e2e-better-auth-secret-0123456789-abcdefghijkl',
  // Fixed test key (32 bytes of "e2e-secrets-key-0123456789abcdef" as base64); never a real secret.
  secretsKey: 'ZTJlLXNlY3JldHMta2V5LTAxMjM0NTY3ODlhYmNkZWY=',
} as const;

const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${PORTS.postgres}/agents`;

interface Managed {
  name: string;
  proc: ChildProcess;
  logFile: string;
}

const managed: Managed[] = [];
let pg: EmbeddedPostgres | undefined;
let pgPid: number | undefined;
/** Set once teardown started (async path) so it is not started twice. */
let tornDown = false;
/** Set once everything is stopped and the data dir is gone; the exit fallback only runs before that. */
let cleaned = false;
let teardownPromise: Promise<void> | undefined;

// ---------------------------------------------------------------- small helpers

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True while the pid runs. A zombie child (exited, not yet reaped) counts as gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && !ps.stdout.trim().startsWith('Z');
}

function logTail(file: string, lines = 40): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function logText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

interface PidFile {
  /** The vitest process that started this stack; leftovers are only reaped once it is gone. */
  owner: number;
  pids: Array<{ pid: number; group: boolean }>;
}

function readPidFile(): PidFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as PidFile;
    return Array.isArray(parsed.pids) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function recordPid(pid: number, group: boolean): void {
  const current = readPidFile() ?? { owner: process.pid, pids: [] };
  writeFileSync(pidFile, JSON.stringify({ ...current, pids: [...current.pids, { pid, group }] }));
}

function signal(pid: number, group: boolean, sig: NodeJS.Signals): void {
  // kill(0)/kill(-0) would signal our own process group: only ever target a real child pid.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(group ? -pid : pid, sig);
  } catch {
    // already gone
  }
}

/** Synchronous bounded wait until a pid exits; used where async work cannot finish (process exit). */
function waitGoneSync(pid: number, ms: number): boolean {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return !alive(pid);
}

/** Refuse to hand a child anything that points at the owner's live stack. */
function assertIsolated(name: string, env: Record<string, string>, args: string[] = []): void {
  const bad = new RegExp(`:(${LIVE_PORTS.join('|')})(?![0-9])`);
  for (const [key, value] of Object.entries({ ...env, ...Object.fromEntries(args.map((a, i) => [`arg${i}`, a])) })) {
    const portVar = key.endsWith('_PORT') && LIVE_PORTS.includes(value);
    if (portVar || bad.test(value)) {
      throw new Error(`[e2e] refusing to start ${name}: ${key}=${value} points at a live dev-stack port`);
    }
  }
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? dataDir,
    TMPDIR: join(dataDir, 'tmp'),
    ...extra,
  };
}

// ---------------------------------------------------------------- ports + stale processes

function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createConnection({ port, host: '127.0.0.1' });
    probe.once('connect', () => {
      probe.destroy();
      done(true);
    });
    probe.once('error', () => {
      const server = createServer();
      server.once('error', () => done(true));
      server.listen(port, '0.0.0.0', () => server.close(() => done(false)));
    });
  });
}

async function assertPortsFree(): Promise<void> {
  const busy: string[] = [];
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portBusy(port)) busy.push(`${name}:${port}`);
  }
  if (busy.length > 0) {
    throw new Error(
      `[e2e] required port(s) already in use: ${busy.join(', ')}.\n` +
        '  A previous e2e run may still be alive. Inspect with:\n' +
        `  lsof -iTCP -sTCP:LISTEN -n -P | grep -E ':(${Object.values(PORTS).join('|')})'\n` +
        '  The harness never touches the live dev ports, so it will not kill anything it did not start.',
    );
  }
}

/**
 * Kill leftovers recorded by a previous crashed run. Only when that run's vitest process is gone
 * (a still-running suite is left alone and the port check aborts instead), and only processes
 * whose command line carries our marker.
 */
function reapStale(): void {
  const previous = readPidFile();
  if (!previous || (previous.owner !== process.pid && alive(previous.owner))) return;
  for (const { pid, group } of previous.pids) {
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (ps.status !== 0 || !STALE_MARKER.test(ps.stdout)) continue;
    signal(pid, group, 'SIGTERM');
    if (!waitGoneSync(pid, 5_000)) signal(pid, group, 'SIGKILL');
  }
}

// ---------------------------------------------------------------- process management

function startProcess(name: string, command: string, args: string[], cwd: string, env: Record<string, string>): Managed {
  assertIsolated(name, env, args);
  const logFile = join(logDir, `${name}.log`);
  const fd = openSync(logFile, 'a');
  const proc = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  if (proc.pid === undefined) throw new Error(`[e2e] failed to spawn ${name}`);
  recordPid(proc.pid, true);
  const entry: Managed = { name, proc, logFile };
  managed.push(entry);
  return entry;
}

function startService(name: string, dir: string, env: Record<string, string>): Managed {
  return startProcess(name, process.execPath, ['--import', 'tsx', 'src/main.ts', '--e2e-stack'], join(repoRoot, 'packages', dir), env);
}

async function fetchOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(label: string, check: () => Promise<boolean>, owner?: Managed): Promise<void> {
  const end = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < end) {
    if (owner && owner.proc.exitCode !== null) {
      throw new Error(`[e2e] ${owner.name} exited early (code ${String(owner.proc.exitCode)}) while waiting for ${label}.\n--- ${owner.name} log tail ---\n${logTail(owner.logFile)}`);
    }
    if (await check()) return;
    await sleep(400);
  }
  const tail = owner ? `\n--- ${owner.name} log tail ---\n${logTail(owner.logFile)}` : '';
  throw new Error(`[e2e] timed out after ${HEALTH_TIMEOUT_MS / 1000}s waiting for ${label}.${tail}`);
}

// ---------------------------------------------------------------- boot steps

const postgresLog = join(logDir, 'postgres.log');

function logPostgres(message: unknown): void {
  try {
    appendFileSync(postgresLog, `${message instanceof Error ? message.message : String(message)}\n`);
  } catch {
    // log dir missing: nothing useful to do
  }
}

async function startPostgres(): Promise<void> {
  const databaseDir = join(dataDir, 'pg');
  pg = new EmbeddedPostgres({
    databaseDir,
    port: PORTS.postgres,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    onLog: logPostgres,
    onError: logPostgres,
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('agents');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[e2e] embedded Postgres failed to start: ${reason}\n--- postgres log tail ---\n${logTail(postgresLog)}`);
  }
  try {
    pgPid = Number(readFileSync(join(databaseDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    if (Number.isInteger(pgPid) && pgPid > 0) recordPid(pgPid, false);
  } catch {
    pgPid = undefined;
  }
}

function migrate(): void {
  const env = cleanEnv({ DATABASE_URL: databaseUrl });
  assertIsolated('migrate', env);
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'src/migrate.ts'], {
    cwd: join(repoRoot, 'packages', 'db'),
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`[e2e] migration failed (status ${String(result.status)}):\n${result.stdout}\n${result.stderr}`);
  }
}

let agentdEnv: Record<string, string> | undefined;
let agentdEntry: Managed | undefined;
let controlServer: Server | undefined;
/** The extra coordinator a scenario asked for (it must wait on the instance lock, never serve). */
let secondCoordinator: Managed | undefined;
/** Execution worker processes by index (E2E_WORKERS); an entry is dropped when the worker is killed. */
const workerEntries = new Map<number, Managed>();

const workerName = (index: number): string => `worker-${String(index)}`;

async function startAgentd(): Promise<void> {
  if (agentdEnv === undefined) throw new Error('[e2e] agentd env not prepared');
  const entry = startService('agentd', 'agentd', agentdEnv);
  agentdEntry = entry;
  await waitUntil('agentd /healthz', () => fetchOk(`http://127.0.0.1:${PORTS.agentd}/healthz`), entry);
}

/** An execution worker: the production agentd entry point with `AGENTD_ROLE=worker`, no HTTP port, a stable lease identity. */
async function startWorker(index: number, concurrency?: number): Promise<void> {
  if (agentdEnv === undefined) throw new Error('[e2e] agentd env not prepared');
  if (workerEntries.has(index)) throw new Error(`[e2e] ${workerName(index)} is already running`);
  const name = workerName(index);
  const before = logText(join(logDir, `${name}.log`)).length;
  const entry = startService(name, 'agentd', { ...agentdEnv, AGENTD_ROLE: 'worker', AGENTD_WORKER_ID: `e2e-${name}`, ...(concurrency === undefined ? {} : { AGENTD_WORKER_CONCURRENCY: String(concurrency) }) });
  workerEntries.set(index, entry);
  try {
    await waitUntil(`${name} running`, async () => logText(entry.logFile).slice(before).includes('Execution worker running'), entry);
  } catch (error) {
    // A worker that refused to boot (no active coordinator) is not part of the fleet.
    workerEntries.delete(index);
    const at = managed.indexOf(entry);
    if (at >= 0) managed.splice(at, 1);
    throw error;
  }
}

/** Terminate one process of the stack and wait until it is gone; drops it from `managed` so teardown does not signal it twice. */
async function killEntry(entry: Managed, sig: NodeJS.Signals): Promise<number | undefined> {
  const pid = entry.proc.pid;
  if (pid !== undefined) {
    signal(pid, true, sig);
    for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(100);
  }
  const at = managed.indexOf(entry);
  if (at >= 0) managed.splice(at, 1);
  return pid;
}

async function killWorker(index: number, sig: NodeJS.Signals): Promise<number | undefined> {
  const entry = workerEntries.get(index);
  if (entry === undefined) throw new Error(`[e2e] ${workerName(index)} is not running`);
  workerEntries.delete(index);
  return killEntry(entry, sig);
}

/**
 * Crash-restart agentd (SIGKILL, like a power cut), then start it again; the runner resumes in-flight work from its journal.
 * With workers the whole fleet goes down and comes back coordinator first, because a worker refuses to start before the
 * coordinator has published its capability marker.
 */
async function restartAgentd(): Promise<void> {
  const indexes = [...workerEntries.keys()].sort();
  for (const index of indexes) await killWorker(index, 'SIGKILL');
  if (agentdEntry !== undefined) await killEntry(agentdEntry, 'SIGKILL');
  for (let i = 0; i < 50 && (await portBusy(PORTS.agentd)); i += 1) await sleep(100);
  await startAgentd();
  for (const index of indexes) await startWorker(index);
}

interface WorkerStatus { index: number; id: string; pid: number | null; alive: boolean }

function workerStatuses(): WorkerStatus[] {
  return Array.from({ length: WORKERS }, (_unused, offset): WorkerStatus => {
    const index = offset + 1;
    const pid = workerEntries.get(index)?.proc.pid;
    return { index, id: `e2e-${workerName(index)}`, pid: pid ?? null, alive: pid !== undefined && alive(pid) };
  });
}

/** A second coordinator against the same database: it must sit on the instance lock and never open its port. */
function startSecondCoordinator(): { pid: number; port: number; logFile: string } {
  if (agentdEnv === undefined) throw new Error('[e2e] agentd env not prepared');
  if (secondCoordinator !== undefined) throw new Error('[e2e] a second coordinator is already running');
  const entry = startService('agentd-second', 'agentd', { ...agentdEnv, AGENTD_ROLE: 'coordinator', AGENTD_PORT: String(PORTS.agentdSecond) });
  secondCoordinator = entry;
  const pid = entry.proc.pid;
  if (pid === undefined) throw new Error('[e2e] second coordinator did not spawn');
  return { pid, port: PORTS.agentdSecond, logFile: entry.logFile };
}

async function stopSecondCoordinator(): Promise<void> {
  if (secondCoordinator === undefined) return;
  const entry = secondCoordinator;
  secondCoordinator = undefined;
  await killEntry(entry, 'SIGKILL');
}

function startControlServer(): Promise<void> {
  const reply = (res: import('node:http').ServerResponse, work: () => Promise<unknown> | unknown): void => {
    Promise.resolve().then(work).then(
      (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body ?? 'ok')); },
      (error: unknown) => { res.writeHead(500); res.end(String(error)); },
    );
  };
  controlServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://control');
    const worker = /^\/workers\/(\d+)\/(kill|start|signal)$/.exec(url.pathname);
    if (req.method === 'POST' && url.pathname === '/restart/agentd') return reply(res, restartAgentd);
    if (req.method === 'GET' && url.pathname === '/workers') return reply(res, workerStatuses);
    if (req.method === 'POST' && worker?.[1] !== undefined && worker[2] === 'kill') {
      const sig = url.searchParams.get('signal') === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL';
      return reply(res, async () => ({ pid: await killWorker(Number(worker[1]), sig) }));
    }
    if (req.method === 'POST' && worker?.[1] !== undefined && worker[2] === 'start') return reply(res, () => startWorker(Number(worker[1]), url.searchParams.has('concurrency') ? Number(url.searchParams.get('concurrency')) : undefined));
    if (req.method === 'POST' && worker?.[1] !== undefined && worker[2] === 'signal') {
      // Freeze / thaw one worker (a stalled process whose lease expires): the process stays, only its scheduling stops.
      const name = url.searchParams.get('name');
      const pid = workerEntries.get(Number(worker[1]))?.proc.pid;
      if ((name !== 'SIGSTOP' && name !== 'SIGCONT') || pid === undefined) { res.writeHead(400); res.end('need name=SIGSTOP|SIGCONT and a running worker'); return; }
      return reply(res, () => { signal(pid, true, name); });
    }
    if (req.method === 'POST' && url.pathname === '/coordinator/second') return reply(res, startSecondCoordinator);
    if (req.method === 'DELETE' && url.pathname === '/coordinator/second') return reply(res, stopSecondCoordinator);
    res.writeHead(404);
    res.end();
  });
  return new Promise((done) => controlServer?.listen(PORTS.control, '127.0.0.1', () => done()));
}

/**
 * Real-model mode (`pnpm test:e2e:real`): agentd calls this model through the local OCX proxy instead
 * of reading the scripted file, so scenarios exercise our harness against a real model.
 */
const realModel = process.env['E2E_REAL_MODEL'];
const realModelBaseUrl = process.env['E2E_MODEL_BASE_URL'] ?? 'http://127.0.0.1:10100/v1';

/** Opt-in real computer (`E2E_COMPUTER_PROVIDER=local`: a throwaway local Docker sandbox); default fake. */
const computerProvider = process.env['E2E_COMPUTER_PROVIDER'] ?? 'fake';
/** The local computer's image: `juno-desktop:local` unless `E2E_SANDBOX_IMAGE` names another tag (a rebuilt image checked before its retag). */
const sandboxImage = process.env['E2E_SANDBOX_IMAGE'] ?? 'juno-desktop:local';

/** The scripted model's context window: small enough that the long-chat scenario makes the harness compact, large enough that short chats never do. */
const SCRIPTED_CONTEXT_WINDOW = '24000';

function modelEnv(scriptFile: string): Record<string, string> {
  // Scripted scenarios wait for the chat digest's quiet window; real-model tests trigger it with runNow instead.
  if (realModel === undefined || realModel.length === 0) return { MODEL_PROVIDER: 'scripted', SCRIPTED_MODEL_FILE: scriptFile, CHAT_DIGEST_QUIET_MS: '3000', SCRIPTED_CONTEXT_WINDOW: SCRIPTED_CONTEXT_WINDOW };
  return { MODEL_BASE_URL: realModelBaseUrl, MODEL_ID: realModel, ...(process.env['E2E_MODEL_SUPPORTS_IMAGES'] === 'true' ? { MODEL_SUPPORTS_IMAGES: 'true' } : {}) };
}

/** Opt-in live web search (`E2E_SEARCH_PROVIDER` + `E2E_SEARCH_API_KEY`, passed explicitly because the stack never reads the root .env); without them web_search is not registered. */
function searchEnv(): Record<string, string> {
  const provider = process.env['E2E_SEARCH_PROVIDER'];
  const key = process.env['E2E_SEARCH_API_KEY'];
  return provider && key ? { SEARCH_PROVIDER: provider, SEARCH_API_KEY: key } : {};
}

/** Explicit, isolated discovery qualification knobs; never inherit the development .env. */
function discoveryEnv(): Record<string, string> {
  const mode = process.env['E2E_TOOL_DISCLOSURE'];
  if (mode !== undefined && !['legacy', 'off', 'on'].includes(mode)) throw new Error('Invalid E2E_TOOL_DISCLOSURE');
  const baseUrl = process.env['E2E_SYSTEM_ONE_BASE_URL'];
  const apiKey = process.env['E2E_SYSTEM_ONE_API_KEY'];
  const modelId = process.env['E2E_SYSTEM_ONE_MODEL_ID'];
  return {
    ...(mode === undefined ? {} : { TOOL_DISCLOSURE: mode }),
    ...(baseUrl && apiKey && modelId ? { SYSTEM_ONE_BASE_URL: baseUrl, SYSTEM_ONE_API_KEY: apiKey, SYSTEM_ONE_MODEL_ID: modelId } : {}),
  };
}

async function startBackend(scriptFile: string): Promise<void> {
  if (realModel !== undefined && realModel.length > 0) {
    await waitUntil('model proxy ' + realModelBaseUrl, () => fetchOk(realModelBaseUrl + '/models'));
  }
  const computerdUrl = `http://127.0.0.1:${PORTS.computerd}`;
  const agentdUrl = `http://127.0.0.1:${PORTS.agentd}`;
  const apiUrl = `http://127.0.0.1:${PORTS.api}`;

  const computerd = startService(
    'computerd',
    'computerd',
    cleanEnv({
      COMPUTERD_PORT: String(PORTS.computerd),
      COMPUTERD_LINK_PORT: String(PORTS.computerdLink),
      COMPUTERD_LINK_HOST: '127.0.0.1',
      COMPUTERD_HOST: '127.0.0.1',
      COMPUTER_PROVIDER: computerProvider,
      LOCAL_SANDBOX_IMAGE: sandboxImage,
      COMPUTERD_TOKEN: SECRETS.computerdToken,
      SCREEN_TICKET_SECRET: SECRETS.screenTicketSecret,
      DATABASE_URL: databaseUrl,
      COMPUTER_BINDING_FILE: join(dataDir, 'computerd-binding.json'),
      SCREEN_REGISTRY_FILE: join(dataDir, 'screen-pool.json'),
      MAC_REGISTRY_FILE: join(dataDir, 'mac-links.json'),
    }),
  );
  await waitUntil('computerd /healthz', () => fetchOk(`${computerdUrl}/healthz`), computerd);

  // memoryd serves the memory port (BACKEND §2.4); agentd reads and writes memory through it, so the scripted e2e exercises the remote path.
  const memorydUrl = `http://127.0.0.1:${PORTS.memoryd}`;
  const memoryd = startService(
    'memoryd',
    'memoryd',
    cleanEnv({
      MEMORYD_PORT: String(PORTS.memoryd),
      MEMORYD_HOST: '127.0.0.1',
      MEMORYD_TOKEN: SECRETS.memorydToken,
      DATABASE_URL: databaseUrl,
      COMPUTERD_URL: computerdUrl,
      COMPUTERD_TOKEN: SECRETS.computerdToken,
    }),
  );
  await waitUntil('memoryd /healthz', () => fetchOk(`${memorydUrl}/healthz`), memoryd);

  agentdEnv = cleanEnv({
      AGENTD_PORT: String(PORTS.agentd),
      // A Microsoft sign-in client the deployment "has", so the Outlook apps count as offerable (a card for them is only a card: no sign-in
      // starts and no Microsoft host is contacted). Google, Strava and the platform keys stay absent.
      MICROSOFT_CLIENT_ID: 'e2e-microsoft-client',
      MICROSOFT_CLIENT_SECRET: 'e2e-microsoft-secret',
      ...COMPOSIO_ENV,
      // Which reasoning tier chat runs use (quick | standard | deep), so real-model runs can be measured per tier.
      ...(process.env['CHAT_EFFORT_TIER'] ? { CHAT_EFFORT_TIER: process.env['CHAT_EFFORT_TIER'] } : {}),
      INTERNAL_AGENTD_TOKEN: SECRETS.internalToken,
      SECRETS_KEY: SECRETS.secretsKey,
      DATABASE_URL: databaseUrl,
      COMPUTERD_URL: computerdUrl,
      COMPUTERD_TOKEN: SECRETS.computerdToken,
      MEMORYD_URL: memorydUrl,
      MEMORYD_TOKEN: SECRETS.memorydToken,
      SCREEN_TICKET_SECRET: SECRETS.screenTicketSecret,
      COMPUTER_PROVIDER: computerProvider,
      ...modelEnv(scriptFile),
      ...searchEnv(),
      ...discoveryEnv(),
      // Memory search by keywords only: the scenarios must not call a hosted embeddings API, whatever the developer's .env says.
      EMBEDDING_BASE_URL: '',
      EMBEDDING_API_KEY: '',
      EMBEDDING_MODEL: '',
      BLOB_DIR: join(dataDir, 'blobs'),
      // Scenarios run fake MCP servers on 127.0.0.1 (tests and local development only; default off in production).
      MCP_ALLOW_PRIVATE_HOSTS: '1',
      // H-89: production refuses routines more frequent than 5 minutes; scenarios use seconds.
      ROUTINE_MIN_INTERVAL_MS: '1000',
      // The split stack: the main agentd is the coordinator and the workers below execute (the default stack is one `all` process).
      ...(WORKERS > 0 ? { AGENTD_ROLE: 'coordinator', AGENTD_LEASE_TTL_MS: SPLIT_LEASE_TTL_MS } : {}),
  });
  await startAgentd();
  for (let index = 1; index <= WORKERS; index += 1) await startWorker(index);

  const api = startService(
    'api',
    'api',
    cleanEnv({
      API_PORT: String(PORTS.api),
      AUTH_MODE: 'account',
      BETTER_AUTH_SECRET: SECRETS.authSecret,
      BETTER_AUTH_URL: apiUrl,
      AUTH_TRUSTED_ORIGINS: apiUrl,
      // The API reports the platform default model to the apps (modelProviders.usable); same model as agentd in real mode.
      ...(realModel === undefined || realModel.length === 0 ? {} : { MODEL_BASE_URL: realModelBaseUrl, MODEL_ID: realModel }),
      DATABASE_URL: databaseUrl,
      // The same blob directory as agentd: uploads land here, attachments are read from here.
      BLOB_DIR: join(dataDir, 'blobs'),
      AGENTD_URL: agentdUrl,
      INTERNAL_AGENTD_TOKEN: SECRETS.internalToken,
      ADMIN_TOKEN: SECRETS.adminToken,
      ...COMPOSIO_ENV,
      MCP_ALLOW_PRIVATE_HOSTS: '1',
      SECRETS_KEY: SECRETS.secretsKey,
      COMPUTERD_URL: computerdUrl,
      SCREEN_TICKET_SECRET: SECRETS.screenTicketSecret,
      ARTIFACT_URL_SECRET: SECRETS.artifactUrlSecret,
      ARTIFACT_HOST: `usercontent.localhost:${PORTS.api}`,
      SPACE_DOMAIN: `spaces.localhost:${PORTS.api}`,
      SPACE_URL_SECRET: SECRETS.spaceUrlSecret,
      COMPUTERD_TOKEN: SECRETS.computerdToken,
    }),
  );
  await waitUntil('api /healthz', () => fetchOk(`${apiUrl}/healthz`), api);
}

// ---------------------------------------------------------------- teardown

function stopManaged(entry: Managed): Promise<void> {
  const pid = entry.proc.pid;
  if (pid === undefined || !alive(pid)) return Promise.resolve();
  signal(pid, true, 'SIGTERM');
  return (async () => {
    const end = Date.now() + STOP_GRACE_MS;
    while (alive(pid) && Date.now() < end) await sleep(100);
    if (alive(pid)) signal(pid, true, 'SIGKILL');
  })();
}

/** Everything of the run goes, except the real-task reports (`real-reports/`, written by `pnpm test:e2e:tasks`): they are the output. */
function wipeDataDir(): void {
  for (const entry of existsSync(dataDir) ? readdirSync(dataDir) : []) {
    if (entry !== 'real-reports') rmSync(join(dataDir, entry), { recursive: true, force: true });
  }
}

function removeDataDir(): void {
  if (process.env['E2E_KEEP'] === '1') {
    console.error(`[e2e] E2E_KEEP=1: leaving ${dataDir} in place (logs in ${logDir})`);
    return;
  }
  wipeDataDir();
}

async function teardown(): Promise<void> {
  if (tornDown) return;
  tornDown = true;
  controlServer?.close();
  for (const entry of [...managed].reverse()) await stopManaged(entry);
  try {
    await pg?.stop();
  } catch {
    // fall through to the signal fallback
  }
  if (pgPid !== undefined && alive(pgPid)) {
    signal(pgPid, false, 'SIGINT');
    if (!waitGoneSync(pgPid, 10_000)) signal(pgPid, false, 'SIGKILL');
  }
  removeDataDir();
  cleaned = true;
}

/**
 * Cleanup when the process is exiting (Ctrl-C, SIGTERM, crash): synchronous only, because nothing
 * async can finish once the event loop is gone. Graceful SIGTERM first, SIGKILL for stragglers.
 */
function exitCleanup(): void {
  if (finalExitCode !== undefined) process.exitCode = finalExitCode;
  if (cleaned) return;
  cleaned = true;
  const pids = managed.flatMap((entry) => (entry.proc.pid === undefined ? [] : [entry.proc.pid]));
  for (const pid of [...pids].reverse()) signal(pid, true, 'SIGTERM');
  for (const pid of pids) {
    if (!waitGoneSync(pid, STOP_GRACE_MS)) signal(pid, true, 'SIGKILL');
  }
  if (pgPid !== undefined && alive(pgPid)) {
    signal(pgPid, false, 'SIGINT');
    if (!waitGoneSync(pgPid, 10_000)) signal(pgPid, false, 'SIGKILL');
  }
  // Orphaned vitest workers are direct children of this process and otherwise keep spinning.
  spawnSync('pkill', ['-KILL', '-P', String(process.pid)]);
  removeDataDir();
}

/**
 * embedded-postgres registers async-exit-hook, whose `beforeExit` handler calls process.exit(0) and so
 * overwrites the exit code vitest set for failed tests. Remember the code at `beforeExit` (ours runs
 * first because it is prepended) and put it back in the `exit` listener.
 */
let finalExitCode: number | undefined;

function rememberExitCode(): void {
  if (typeof process.exitCode === 'number' && process.exitCode !== 0) finalExitCode = process.exitCode;
}

function runTeardown(): Promise<void> {
  teardownPromise ??= teardown();
  return teardownPromise;
}

// ---------------------------------------------------------------- vitest entry

// vitest loads this file once per project, so the shared state lives on globalThis.
const shared = globalThis as typeof globalThis & { __e2eBoot?: { booted: Promise<E2eContext>; users: number } };

/** Both vitest projects (parallel, exclusive) run this globalSetup in one process: boot the stack once, stop it after the last. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const boot = (shared.__e2eBoot ??= { booted: bootStack(), users: 0 });
  boot.users += 1;
  project.provide('e2e', await boot.booted);
  return async () => {
    boot.users -= 1;
    if (boot.users === 0) await runTeardown();
  };
}

async function bootStack(): Promise<E2eContext> {
  // Vitest's own SIGINT/SIGTERM handler calls process.exit() synchronously, and its own 'exit'
  // listener re-enters process.exit(), which skips any listener registered after it. Prepend ours
  // so the synchronous cleanup always runs.
  process.prependOnceListener('exit', exitCleanup);
  process.prependListener('beforeExit', rememberExitCode);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      // Stop the stack first, then give vitest a moment to wind down its workers before exiting.
      void runTeardown().finally(() => setTimeout(() => process.exit(sig === 'SIGINT' ? 130 : 143), 3_000));
    });
  }

  try {
    reapStale();
    try {
      await assertPortsFree();
    } catch (error) {
      // Nothing of ours is running yet: do not delete or kill anything on a preflight failure.
      tornDown = true;
      cleaned = true;
      throw error;
    }
    wipeDataDir();
    mkdirSync(logDir, { recursive: true });
    mkdirSync(join(dataDir, 'tmp'), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({ owner: process.pid, pids: [] }));

    const scriptFile = join(dataDir, 'scripted-model.json');
    writeFileSync(scriptFile, '{}');

    await startPostgres();
    migrate();
    await startBackend(scriptFile);
    await startControlServer();

    return {
      composioUrl: COMPOSIO_ENV.COMPOSIO_BASE_URL,
      composioKey: COMPOSIO_ENV.COMPOSIO_API_KEY,
      apiUrl: `http://127.0.0.1:${PORTS.api}`,
      agentdUrl: `http://127.0.0.1:${PORTS.agentd}`,
      internalToken: SECRETS.internalToken,
      scriptFile,
      databaseUrl,
      controlUrl: `http://127.0.0.1:${PORTS.control}`,
      computerdUrl: `http://127.0.0.1:${PORTS.computerd}`,
      computerdToken: SECRETS.computerdToken,
      spaceUrl: `http://127.0.0.1:${PORTS.api}`,
      spaceDomain: `spaces.localhost:${PORTS.api}`,
      artifactHost: `usercontent.localhost:${PORTS.api}`,
      spaceUrlSecret: SECRETS.spaceUrlSecret,
      artifactUrlSecret: SECRETS.artifactUrlSecret,
      workers: WORKERS,
    };
  } catch (error) {
    // Vitest does not run the returned teardown when setup throws, so clean up here.
    console.error(error instanceof Error ? error.message : String(error));
    await runTeardown();
    throw error;
  }
}
