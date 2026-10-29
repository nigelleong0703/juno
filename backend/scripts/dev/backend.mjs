#!/usr/bin/env node
/**
 * Dev backend launcher: api (public) + agentd (private control/execution) + computerd + memoryd.
 *
 * Services (direct node children, so each service PID is owned here):
 * - api on API_PORT (default 8787, public entry)
 * - agentd on AGENTD_PORT (default 8788, loopback only) plus the durable runner in the same process. With DEV_AGENTD_WORKERS=N (N > 0)
 *   it is split like production (BACKEND 2.2c): agentd runs as AGENTD_ROLE=coordinator on the same port and N more agentd processes
 *   (AGENTD_ROLE=worker, ids dev-worker-1..N, no port) execute the runs. Unset or 0: the single process, as before.
 * - computerd on COMPUTERD_PORT (default 8791)
 * - memoryd on MEMORYD_PORT (default 8796, loopback): the memory service (BACKEND §2.4). Not optional: agentd reads and writes memory
 *   through it (MEMORYD_URL is set for agentd here). With MEMORYD_TOKEN unset in .env, the launch makes a random token and gives it
 *   to memoryd and agentd (memoryd-launch.mjs); pin MEMORYD_TOKEN to keep one across launches.
 * - tts (only when TTS_ENABLED=1): the Kokoro speech sidecar services/tts/server.py run by TTS_PYTHON on TTS_PORT
 *   (default 8792, loopback).
 *
 * A service that exits while the launcher runs is restarted alone, with the backoff of restart-policy.mjs; the others keep
 * running. (On 2026-10-26 agentd lost its instance lock, exited, and was not restarted: the backend stayed down for 1.5 hours.)
 * A service whose process cannot be spawned at all still stops the launcher, since a restart would fail the same way.
 *
 * Each service spawns as `node --import tsx src/main.ts` with cwd packages/<service>.
 * Spawning node directly (no pnpm wrapper) keeps the service as the direct child,
 * so SIGTERM/SIGKILL always reaches the actual listener and no port is left behind.
 * Root .env is loaded centrally with Node loadEnvFile before children spawn, so
 * every service inherits the same values (service .env-file flags, if any, never
 * override these). Secrets are never printed.
 *
 * Shutdown is bounded: on SIGINT/SIGTERM or a spawn failure the launcher sends
 * SIGTERM to all alive children, waits up to GRACEFUL_WAIT_MS, then SIGKILLs
 * stragglers and exits. The parent always exits; no listener is left behind.
 *
 * Infra prerequisite (NOT started here): run `pnpm dev:infra` separately for
 * Postgres, then migrate as needed. This launcher never seeds, resets, wipes data,
 * provisions accounts, or starts duplicate infra on live ports.
 *
 * Bind notes: computerd binds COMPUTERD_HOST (default 127.0.0.1) and this launcher sets it.
 * agentd always binds 127.0.0.1 (no host env), so the launcher sets no host var for it.
 *
 * Usage: pnpm dev:backend
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { restartDelayMs } from './restart-policy.mjs';
import { memorydLaunch } from './memoryd-launch.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = join(rootDir, '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const API_PORT = process.env['API_PORT'] ?? '8787';
const AGENTD_PORT = process.env['AGENTD_PORT'] ?? '8788';
const AGENTD_URL = process.env['AGENTD_URL'] ?? `http://127.0.0.1:${AGENTD_PORT}`;
const COMPUTERD_PORT = process.env['COMPUTERD_PORT'] ?? '8791';
const COMPUTERD_URL = process.env['COMPUTERD_URL'] ?? `http://127.0.0.1:${COMPUTERD_PORT}`;
// memoryd: with no MEMORYD_TOKEN in .env, this launch makes one and hands it to memoryd and agentd alike (memoryd-launch.mjs).
const memoryd = memorydLaunch(process.env, (bytes) => randomBytes(bytes).toString('hex'));
const MEMORYD_PORT = memoryd.port;
const MEMORYD_URL = memoryd.url;
const MEMORYD_TOKEN = memoryd.token;
const INTERNAL_AGENTD_TOKEN = process.env['INTERNAL_AGENTD_TOKEN'] ?? '';
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';

const TTS_PORT = process.env['TTS_PORT'] ?? '8792';

const GRACEFUL_WAIT_MS = 5000;

function fail(message) {
  console.error(`[backend] ${message}`);
  process.exit(1);
}

if (!INTERNAL_AGENTD_TOKEN) {
  fail('INTERNAL_AGENTD_TOKEN is not set. Copy .env.example to .env and set a value.');
}


if (!process.env['SECRETS_KEY']) {
  fail('SECRETS_KEY is not set. Generate one with `openssl rand -base64 32` and put it in .env.');
}

if (!DATABASE_URL) {
  fail('DATABASE_URL is not set. Start the infra prerequisite (`pnpm dev:infra`) and set DATABASE_URL from .env.example.');
}

const WORKERS = Number(process.env['DEV_AGENTD_WORKERS'] || 0);
if (!Number.isInteger(WORKERS) || WORKERS < 0 || WORKERS > 8) {
  fail(`DEV_AGENTD_WORKERS must be a whole number from 0 to 8 (got "${process.env['DEV_AGENTD_WORKERS']}"). 0 or unset runs one agentd process.`);
}

const agentdEnv = {
  AGENTD_PORT,
  AGENTD_URL,
  INTERNAL_AGENTD_TOKEN,
  MEMORYD_URL,
  MEMORYD_TOKEN,
};

const services = [
  {
    name: 'api',
    dir: join(rootDir, 'packages', 'api'),
    env: { API_PORT, AGENTD_URL, INTERNAL_AGENTD_TOKEN },
  },
  {
    name: 'computerd',
    dir: join(rootDir, 'packages', 'computerd'),
    env: { COMPUTERD_PORT, COMPUTERD_URL, COMPUTERD_HOST: '127.0.0.1' },
  },
  // memoryd starts before agentd: agentd's first memory read then finds it up (and degrades to empty memory until it is, if not).
  {
    name: 'memoryd',
    dir: join(rootDir, 'packages', 'memoryd'),
    env: { MEMORYD_PORT, MEMORYD_HOST: '127.0.0.1', MEMORYD_TOKEN, COMPUTERD_URL },
  },
  {
    name: 'agentd',
    dir: join(rootDir, 'packages', 'agentd'),
    env: WORKERS > 0 ? { ...agentdEnv, AGENTD_ROLE: 'coordinator', AGENTD_EXPECTED_WORKERS: String(WORKERS) } : agentdEnv,
  },
];

// Execution workers: the same entry point and env, a stable lease identity each, and no HTTP port (a worker never listens).
// A worker that exits is restarted like any service; its runs are taken over by the others once its lease runs out.
for (let index = 1; index <= WORKERS; index += 1) {
  services.push({
    name: `agentd-worker-${index}`,
    dir: join(rootDir, 'packages', 'agentd'),
    env: { ...agentdEnv, AGENTD_ROLE: 'worker', AGENTD_WORKER_ID: `dev-worker-${index}`, AGENTD_EXPECTED_WORKERS: String(WORKERS) },
  });
}

if (process.env['TTS_ENABLED'] === '1') {
  const python = process.env['TTS_PYTHON'];
  if (!python) {
    fail('TTS_ENABLED=1 needs TTS_PYTHON, the python that has services/tts/requirements.txt installed (see services/tts/README.md).');
  }
  const ttsDir = join(rootDir, 'services', 'tts');
  services.push({
    name: 'tts',
    dir: ttsDir,
    command: python,
    args: ['server.py'],
    // Spoken replies are optional (clients fall back to on-device speech): if the sidecar cannot even be spawned the
    // launcher carries on without it. A sidecar that exits is restarted with backoff, like every service.
    optional: true,
    env: {
      TTS_PORT: TTS_PORT,
      ...(process.env['TTS_ESPEAK_LIBRARY'] ? { TTS_ESPEAK_LIBRARY: process.env['TTS_ESPEAK_LIBRARY'] } : {}),
      ...(process.env['TTS_ESPEAK_DATA'] ? { TTS_ESPEAK_DATA: process.env['TTS_ESPEAK_DATA'] } : {}),
    },
  });
}

for (const service of services) {
  if (service.command === undefined && !existsSync(join(service.dir, 'src', 'main.ts'))) {
    fail(`${service.name} entry missing at ${service.dir}/src/main.ts (owner stream pending); not starting a partial backend.`);
  }
}

const children = [];
let shuttingDown = false;
let pendingExitCode = 0;
let killTimer = null;

function aliveChildren() {
  return children.filter((entry) => entry.proc.exitCode === null);
}

function finishExit() {
  if (killTimer !== null) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  process.exit(pendingExitCode);
}

function requestShutdown(exitCode, reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  pendingExitCode = exitCode;
  console.error(`[backend] ${reason}; stopping siblings`);
  console.error('[backend] infra prerequisite: `pnpm dev:infra` must already be running; this launcher never starts infra.');
  for (const entry of aliveChildren()) {
    entry.proc.kill('SIGTERM');
  }
  if (aliveChildren().length === 0) {
    finishExit();
    return;
  }
  killTimer = setTimeout(() => {
    for (const entry of aliveChildren()) {
      entry.proc.kill('SIGKILL');
    }
    finishExit();
  }, GRACEFUL_WAIT_MS);
}

function onChildExit(entry, code, signal) {
  if (shuttingDown) {
    if (aliveChildren().length === 0) {
      finishExit();
    }
    return;
  }
  const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
  restartService(entry, reason);
}

/** A service that exits while the launcher runs is restarted alone after a backoff (restart-policy.mjs); its siblings keep running. */
function restartService(entry, reason) {
  const index = children.indexOf(entry);
  if (index !== -1) children.splice(index, 1);
  const upMs = Date.now() - entry.startedAt;
  const delay = restartDelayMs({ lastDelayMs: entry.lastDelayMs, upMs });
  const restarts = entry.restarts + 1;
  console.error(`[backend] ${entry.name} exited (${reason}); restart ${restarts} in ${delay / 1000}s, other services keep running`);
  setTimeout(() => {
    if (!shuttingDown) startService(entry.service, { lastDelayMs: delay, restarts });
  }, delay);
}

/** `previous` is the start this one replaces (its restart wait and count); absent for the first start. */
function startService(service, previous = { lastDelayMs: undefined, restarts: 0 }) {
  let proc = null;
  try {
    proc = spawn(service.command ?? process.execPath, service.args ?? ['--import', 'tsx', 'src/main.ts'], {
      cwd: service.dir,
      stdio: 'inherit',
      env: { ...process.env, ...service.env },
    });
  } catch (error) {
    if (service.optional) {
      console.error(`[backend] failed to spawn ${service.name}: ${error.message}; continuing without it`);
      return;
    }
    requestShutdown(1, `failed to spawn ${service.name}: ${error.message}`);
    return;
  }
  if (previous.restarts > 0) console.error(`[backend] ${service.name} restarted (restart ${previous.restarts})`);
  const entry = { name: service.name, proc, service, startedAt: Date.now(), lastDelayMs: previous.lastDelayMs, restarts: previous.restarts };
  children.push(entry);
  proc.on('error', (error) => {
    if (service.optional) {
      console.error(`[backend] ${service.name} error: ${error.message}`);
      return;
    }
    requestShutdown(1, `failed to start ${service.name}: ${error.message}`);
  });
  proc.on('exit', (code, signal) => {
    onChildExit(entry, code, signal);
  });
}

for (const service of services) {
  if (shuttingDown) {
    break;
  }
  startService(service);
}

console.log(`[backend] api :${API_PORT} (public), agentd :${AGENTD_PORT} (loopback), computerd :${COMPUTERD_PORT}, memoryd :${MEMORYD_PORT} (loopback)${WORKERS > 0 ? `, ${WORKERS} execution workers (agentd is the coordinator)` : ''}${process.env['TTS_ENABLED'] === '1' ? `, tts :${TTS_PORT} (loopback)` : ''}`);
console.log('[backend] infra prerequisite: Postgres via `pnpm dev:infra` (separate terminal).');
if (memoryd.generated) console.log('[backend] memoryd: using a per-launch token (set MEMORYD_TOKEN to pin it)');

process.on('SIGINT', () => requestShutdown(130, 'received SIGINT'));
process.on('SIGTERM', () => requestShutdown(143, 'received SIGTERM'));
