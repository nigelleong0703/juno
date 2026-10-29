#!/usr/bin/env node

/**
 * Docker Postgres 18 support for the dev infra launcher (OPS2).
 *
 * The default dev database is the persistent container `vomu-postgres` backed by
 * the named volume `vomu-postgres18-local-use`, so data survives host restarts.
 * This helper only starts or observes that container: it never stops, recreates
 * or removes it, and it never logs or writes the password.
 *
 * Credentials come from the gitignored root .env (POSTGRES_USER,
 * POSTGRES_PASSWORD, POSTGRES_DB, POSTGRES_PORT).
 */
import { spawn } from 'node:child_process';

export const COMPOSE_FILE = 'docker-compose.infra.yaml';
export const POSTGRES_CONTAINER_NAME = 'vomu-postgres';
export const DEFAULT_POSTGRES_PORT = 54330;

/** Read Postgres connection settings from the environment, applying defaults. */
export function readPostgresConfig(env = process.env) {
  return {
    port: Number(env.POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT),
    user: env.POSTGRES_USER ?? 'postgres',
    password: env.POSTGRES_PASSWORD ?? '',
    database: env.POSTGRES_DB ?? 'agents',
  };
}

/** Build the loopback DATABASE_URL; user and password are percent-encoded. */
export function databaseUrlFor({ port, user, password, database }) {
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@127.0.0.1:${port}/${database}`;
}

/** Run a command to completion, capturing output so failures never dump secrets to the terminal. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', (error) => reject(new Error(`${command} failed to start: ${error.message}`)));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Inspect the container; returns false when it does not exist yet. */
async function isContainerRunning(containerName) {
  const result = await run('docker', ['inspect', '--format', '{{.State.Running}}', containerName]);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/** Poll the container's compose healthcheck (pg_isready) until it reports healthy. */
async function waitForHealthy(containerName, log) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', containerName]);
    const status = result.stdout.trim();
    if (result.code === 0 && status === 'healthy') {
      log.info({ containerName }, 'Docker Postgres is healthy');
      return;
    }
    if (status === 'unhealthy') {
      throw new Error(`Docker Postgres container ${containerName} is unhealthy`);
    }
    await delay(1000);
  }
  throw new Error(`Docker Postgres container ${containerName} did not become healthy`);
}

/**
 * Ensure the persistent Docker Postgres is running and healthy, then return its
 * DATABASE_URL. An already-running container is reused as-is, so the launcher
 * never recreates or restarts the long-lived dev database.
 */
export async function startDockerPostgres(log, { cwd, env = process.env } = {}) {
  const config = readPostgresConfig(env);
  if (!config.password) {
    throw new Error('POSTGRES_PASSWORD is not set. Copy .env.example to .env and set the Docker Postgres credentials.');
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error('POSTGRES_PORT must be a positive integer.');
  }

  if (await isContainerRunning(POSTGRES_CONTAINER_NAME)) {
    log.info({ containerName: POSTGRES_CONTAINER_NAME }, 'Docker Postgres already running; reusing it');
  } else {
    log.info({ composeFile: COMPOSE_FILE, containerName: POSTGRES_CONTAINER_NAME }, 'Starting Docker Postgres');
    const up = await run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'postgres'], { cwd, env });
    if (up.code !== 0) {
      throw new Error(`docker compose up failed (exit ${up.code}): ${(up.stderr || up.stdout).trim()}`);
    }
  }

  await waitForHealthy(POSTGRES_CONTAINER_NAME, log);
  log.info({ host: '127.0.0.1', port: config.port, database: config.database }, 'Docker Postgres ready');
  return databaseUrlFor(config);
}
