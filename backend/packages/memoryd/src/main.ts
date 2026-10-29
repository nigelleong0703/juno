/**
 * memoryd entry point (BACKEND §2.4): the memory service. It owns the memory tables' reads and writes for the agent runtime (items,
 * people and accounts, relations, the views it renders into the owner's computer) and serves them over the internal contract.
 *
 * It builds the same memory assembly agentd does (juno-agent's createMemoryModule), over the same Postgres and the same computer.
 * Presence is enforced in the port for every caller; this process only exposes it behind the internal bearer.
 */
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createStore } from '@agent-desktop/db';
import { createLogger } from '@agent-desktop/log';
import { createMemoryModule, type MemoryLog } from 'juno-agent/modules/memory/assembly';
import { createEmbedder } from 'juno-agent/modules/memory/embedder';
import { createComputerdClient } from 'juno-agent/execution/infrastructure/computerd-executor/client';
import { requireOwnerId } from 'juno-agent/owner-context';
import { createMemoryServer } from './server.js';

const log = createLogger({ service: 'memoryd' });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required: memoryd keeps its memory in the same Postgres as agentd'),
  MEMORYD_TOKEN: z.string().min(1, 'MEMORYD_TOKEN is required: memoryd has no built-in default'),
  MEMORYD_HOST: z.string().default('127.0.0.1'),
  MEMORYD_PORT: z.coerce.number().int().positive().default(8796),
  /** Postgres connections this service may hold (default 10); agentd counts them in its connection budget (BACKEND 2.2c). */
  MEMORYD_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  COMPUTERD_URL: z.string().default('http://127.0.0.1:8791'),
  COMPUTERD_TOKEN: z.string().min(1, 'COMPUTERD_TOKEN is required: the views are written to the owner computer'),
});

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const store = await createStore(env.DATABASE_URL, { poolMax: env.MEMORYD_DB_POOL_MAX });
  if (store.raw === undefined) throw new Error('memoryd needs Postgres: the memory tables are raw SQL');
  const memoryLog: MemoryLog = {
    info: (fields, message) => log.info(fields, message),
    warn: (fields, message) => log.warn(fields, message),
    error: (fields, message) => log.error(fields, message),
  };
  // The views are written through the owner's computer, as agentd writes them: the owner comes from the request scope.
  const computerd = createComputerdClient({
    baseUrl: env.COMPUTERD_URL,
    token: env.COMPUTERD_TOKEN,
    fetch: (input, init) => fetch(input, init),
    getOwnerId: () => requireOwnerId(),
  });
  const embedder = createEmbedder(process.env, { log: (fields, message) => log.warn(fields, message) });
  const memory = createMemoryModule({ store, raw: store.raw, ...(embedder === undefined ? {} : { embedder }), ...(computerd.home === undefined ? {} : { home: computerd.home }), log: memoryLog });
  if (memory === undefined) throw new Error('memoryd could not assemble the memory module');
  memory.start();

  const app = createMemoryServer({ port: memory.port, token: env.MEMORYD_TOKEN, log: (fields, message) => log.error(fields, message) });
  const server = serve({ fetch: app.fetch, port: env.MEMORYD_PORT, hostname: env.MEMORYD_HOST }, (info) => {
    log.info({ address: info.address, port: info.port }, `memoryd listening on http://${info.address}:${info.port}`);
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'memoryd stopping');
    server.close();
    memory.stop();
    void store.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'memoryd failed to start');
  process.exit(1);
});
