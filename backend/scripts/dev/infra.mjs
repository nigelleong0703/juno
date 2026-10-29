#!/usr/bin/env node

/**
 * Dev infrastructure: Postgres.
 *
 * Postgres mode comes from INFRA_POSTGRES_MODE:
 * - "docker" (default): the persistent Docker Postgres 18 container
 *   (vomu-postgres, named volume vomu-postgres18-local-use) on port 54330.
 *   The launcher only runs `docker compose up -d postgres` and never stops,
 *   recreates or removes that container/volume on shutdown.
 * - "embedded": isolated test mode; embedded-postgres on the old port 54329
 *   under INFRA_DATA_DIR. Explicit opt-in only.
 *
 * Health checks the database and waits for readiness. Cleans up spawned children on
 * SIGINT/SIGTERM (the Docker Postgres container is intentionally left running).
 *
 * Usage: pnpm dev:infra
 * Creates: ./.data/pg (embedded mode only)
 */

import { mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createConnection } from 'net';
import EmbeddedPostgres from 'embedded-postgres';
import { createLogger } from '@agent-desktop/log';
import { startDockerPostgres } from './docker-postgres.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '../..');
// Load root .env first so INFRA_DATA_DIR from the file applies consistently here.
// The launcher (`pnpm dev:backend`) never starts infra itself.
const rootEnvPath = join(rootDir, '.env');
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}
// INFRA_DATA_DIR lets verification and fresh runs (e.g. .data/local-use) use a
// throwaway directory instead of the dev data.
const dataDir = process.env.INFRA_DATA_DIR ? resolve(process.env.INFRA_DATA_DIR) : join(rootDir, '.data');

const EMBEDDED_PG_PORT = 54329;
const POSTGRES_MODE = process.env.INFRA_POSTGRES_MODE ?? 'docker';
const useEmbeddedPostgres = POSTGRES_MODE === 'embedded';

const log = createLogger({ service: 'infra' });

/** Probe a TCP port; resolves true when it accepts a connection, false on error or timeout. */
const healthCheck = (port) => {
  return new Promise((resolve) => {
    const socket = createConnection(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1000);
  });
};

/** Poll a port every 500ms for up to 30s; throws if it never becomes ready. */
const waitForService = async (port, name) => {
  log.info({ port, name }, 'Waiting for service');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await healthCheck(port)) {
      log.info({ port, name }, 'Service is ready');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.error({ port, name, timeoutSeconds: 30 }, 'Service failed to start');
  throw new Error(`${name} health check failed`);
};

const processes = [];
let pg;

/** Embedded test mode: initialise if needed, start embedded Postgres on 54329, create the database, and wait. */
const startPostgres = async () => {
  const pgDataDir = join(dataDir, 'pg');
  const entries = await readdir(pgDataDir).catch(() => []);
  const isDirEmpty = entries.length === 0;
  log.info({ pgDataDir, isDirEmpty }, 'Embedded Postgres data directory');

  pg = new EmbeddedPostgres({
    databaseDir: pgDataDir,
    port: EMBEDDED_PG_PORT,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
  });

  if (isDirEmpty) {
    log.info('Initialising embedded-postgres');
    await pg.initialise();
  }

  log.info('Starting embedded-postgres');
  await pg.start();

  try {
    await pg.createDatabase('agents');
    log.info("Created database 'agents'");
  } catch (error) {
    if (error.message && error.message.includes('already exists')) {
      log.info("Database 'agents' already exists");
    } else {
      throw error;
    }
  }

  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${EMBEDDED_PG_PORT}/agents`;
  await waitForService(EMBEDDED_PG_PORT, 'embedded-postgres');
};

/** Default mode: start (or reuse) the Docker Postgres 18 container and derive DATABASE_URL for children. */
const startDockerPostgresDb = async () => {
  process.env.DATABASE_URL = await startDockerPostgres(log, { cwd: rootDir, env: process.env });
};

/** Kill children, stop Postgres, then force-kill anything still alive after 5s. */
const shutdown = async () => {
  log.info('Shutting down');
  for (const { name, proc } of processes) {
    log.info({ name }, 'Terminating process');
    proc.kill();
  }

  if (pg) {
    try {
      log.info('Terminating embedded-postgres');
      await pg.stop();
    } catch (error) {
      log.error({ err: error }, 'Error stopping postgres');
    }
  }

  setTimeout(() => {
    const remaining = processes.filter((p) => !p.proc.killed);
    if (remaining.length > 0) {
      log.info('Force killing remaining processes');
      for (const { proc } of remaining) {
        proc.kill('SIGKILL');
      }
    }
    process.exit(0);
  }, 5000);
};

// Create data directories
await mkdir(dataDir, { recursive: true });
if (useEmbeddedPostgres) {
  await mkdir(join(dataDir, 'pg'), { recursive: true });
}

log.info({ dataDir, postgresMode: POSTGRES_MODE }, 'Starting development infrastructure');

try {
  if (useEmbeddedPostgres) {
    await startPostgres();
  } else {
    await startDockerPostgresDb();
  }

  const pgUrl = new URL(process.env.DATABASE_URL);
  log.info('Infrastructure ready');
  log.info({ host: pgUrl.hostname, port: pgUrl.port, database: pgUrl.pathname.slice(1) }, 'Postgres');
  log.info('Press Ctrl+C to stop.');
  // Stay up (the Docker container is separate) so a service unit running this script stays active.
  setInterval(() => undefined, 2 ** 30);
} catch (error) {
  log.error({ err: error }, 'Startup failed');
  for (const p of processes) {
    p.proc?.kill();
  }
  if (pg) {
    try {
      await pg.stop();
    } catch {
      // Ignore errors during cleanup
    }
  }
  process.exit(1);
}

// Cleanup on SIGINT/SIGTERM; the Docker Postgres container is left running by design.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
