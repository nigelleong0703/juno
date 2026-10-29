/**
 * Embedded Juno (SDK-02): the public API and agentd in this Node process, on a throwaway embedded Postgres and
 * free ports, for scripts and tests. The same code paths as the hosted stack; no Restate, no separate processes.
 *
 * Limits, by design: one embedded Juno per process, and after stop() the process starts no other (the backend reads
 * its settings once per process). The database is always a fresh one; `dataDir` keeps only the file store.
 * No computer by default: pass COMPUTERD_URL and COMPUTERD_TOKEN in `env` to use a computerd you run (the same as dev).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startScratchPostgres } from '@agent-desktop/db/testing/scratch-postgres';
import { applyEnv, buildEmbeddedEnv, generateSecrets, pickFreePorts } from './env.js';

export interface EmbeddedOptions {
  /**
   * Where the file store goes (uploads and caches). Absent: a temporary directory that stop() removes.
   * Given: kept, and stop() leaves it in place.
   */
  dataDir?: string;
  /**
   * Backend settings by env name, on top of the inherited process environment. The model provider goes here
   * (for example MODEL_PROVIDER=scripted with SCRIPTED_MODEL_FILE, or MODEL_BASE_URL and MODEL_ID). Setting a key the
   * runtime owns (DATABASE_URL, the ports, the auth URLs, the internal tokens) throws. COMPUTERD_URL and COMPUTERD_TOKEN
   * opt in to a computer.
   */
  env?: Record<string, string>;
}

export interface EmbeddedJuno {
  /** The public API (the same /v1 paths as the hosted API), e.g. http://127.0.0.1:52817. */
  baseUrl: string;
  /** A bearer token for the account the runtime created: send it as `Authorization: Bearer <token>`. */
  token: string;
  /** The account's owner id. */
  ownerId: string;
  /** Where the file store is: the given dataDir, or the temporary one (removed by stop()). */
  dataDir: string;
  /** The ports the api and agentd listen on (agentd is private; it is here for checks). */
  ports: { api: number; agentd: number };
  /** Stop agentd and the api, close the database, restore the process environment, and remove a temporary dataDir. Idempotent. */
  stop: () => Promise<void>;
}

let started = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function waitFor(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet: keep polling until the deadline.
    }
    if (Date.now() > deadline) throw new Error(`embedded Juno: ${label} did not become ready at ${url}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Sign up one account through the public API (the same path as the apps) and return its bearer token. */
async function signUp(apiUrl: string): Promise<{ token: string; ownerId: string }> {
  const response = await fetch(apiUrl + '/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: apiUrl },
    body: JSON.stringify({
      email: `embedded-${randomUUID().slice(0, 8)}@embedded.test`,
      password: randomBytes(16).toString('hex'),
      name: 'Embedded',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const user = isRecord(body) ? body['user'] : undefined;
  const ownerId = isRecord(user) ? user['id'] : undefined;
  // The bearer plugin returns the session token in this header on sign-up; it is the credential the API accepts.
  const token = response.headers.get('set-auth-token');
  if (!response.ok || token === null || typeof ownerId !== 'string') {
    throw new Error(`embedded Juno: sign-up failed with status ${String(response.status)}`);
  }
  return { token, ownerId };
}

/**
 * Start Juno in this process. Resolves when the API and agentd answer their health checks and one account exists.
 * Rejects (and cleans up everything it started) when any part fails to start.
 */
export async function startEmbeddedJuno(options: EmbeddedOptions = {}): Promise<EmbeddedJuno> {
  if (started) {
    throw new Error('embedded Juno was already started in this process; the backend reads its settings once per process, so start it from a new process');
  }
  started = true;
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'juno-embedded-'));
  mkdirSync(dataDir, { recursive: true });

  // Each teardown step is pushed as the step it undoes starts; they run in reverse, so a half-started runtime unwinds cleanly.
  const teardown: Array<() => Promise<void> | void> = [];
  const stopAll = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const step of teardown.reverse()) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    teardown.length = 0;
    if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    if (errors.length > 0) throw new AggregateError(errors, 'embedded Juno did not stop cleanly');
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= stopAll();
    return stopping;
  };

  try {
    const database = await startScratchPostgres();
    teardown.push(() => database.close());
    const [apiPort, agentdPort] = await pickFreePorts(2);
    if (apiPort === undefined || agentdPort === undefined) throw new Error('embedded Juno: no free ports');
    const env = buildEmbeddedEnv({
      inherited: process.env,
      caller: options.env ?? {},
      databaseUrl: database.url,
      apiPort,
      agentdPort,
      dataDir,
      secrets: generateSecrets(),
    });
    // The backend modules read their settings from process.env when they are first loaded, so the env is set before the import.
    teardown.push(applyEnv(env));
    const { startAgentd } = await import('@agent-desktop/agentd/boot');
    const agentd = await startAgentd({ port: agentdPort });
    teardown.push(() => agentd.stop());
    const { startApi } = await import('@agent-desktop/api/boot');
    const api = await startApi(env);
    teardown.push(() => api.stop());

    const baseUrl = `http://127.0.0.1:${String(apiPort)}`;
    await waitFor(`http://127.0.0.1:${String(agentdPort)}/healthz`, 'agentd');
    await waitFor(`${baseUrl}/healthz`, 'api');
    const account = await signUp(baseUrl);
    return { baseUrl, token: account.token, ownerId: account.ownerId, dataDir, ports: { api: apiPort, agentd: agentdPort }, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
