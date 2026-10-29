#!/usr/bin/env node
/**
 * Local dev stack helper: what is running on this machine, and from which checkout.
 *
 *   pnpm stack status   ports, owning process, its working directory, health, Docker containers
 *   pnpm stack stop     SIGTERM api, agentd, computerd, memoryd and web by port (Docker is left alone)
 *
 * Nothing here installs or starts anything. Postgres and sandbox containers are Docker's: see the
 * "Local dev machine" section of README.md for starting them and for removing everything.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const siblingRoot = dirname(repoRoot);

const SERVICES = [
  { port: 8787, name: 'api', health: 'http://127.0.0.1:8787/healthz' },
  { port: 8788, name: 'agentd' },
  { port: 8791, name: 'computerd' },
  { port: 8796, name: 'memoryd', health: 'http://127.0.0.1:8796/healthz' },
  { port: 5199, name: 'web (frontend repo)' },
  { port: 54330, name: 'postgres (docker)', external: true },
];
const STOPPABLE = new Set([8787, 8788, 8791, 8796, 5199]);

function sh(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function listener(port) {
  const pid = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']).match(/^p(\d+)/m)?.[1];
  if (!pid) return undefined;
  const cwd = sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).match(/^n(.+)$/m)?.[1] ?? '?';
  return { pid: Number(pid), cwd };
}

async function healthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? 'healthy' : `HTTP ${res.status}`;
  } catch {
    return 'no answer';
  }
}

async function status() {
  console.log(`checkout: ${repoRoot}\n`);
  for (const service of SERVICES) {
    const found = listener(service.port);
    if (!found) {
      console.log(`DOWN  :${service.port}  ${service.name}`);
      continue;
    }
    const health = service.health ? `  ${await healthy(service.health)}` : '';
    const here = service.external || found.cwd.startsWith(repoRoot) || found.cwd.startsWith(siblingRoot + '/frontend');
    const where = found.cwd.startsWith(siblingRoot + '/') ? found.cwd.slice(siblingRoot.length + 1) : found.cwd;
    console.log(`UP    :${service.port}  ${service.name}  pid ${found.pid}  ${where}${health}${here ? '' : '   <-- NOT from this checkout (stale?)'}`);
  }
  console.log('\ndocker:');
  const docker = sh('docker', ['ps', '-a', '--filter', 'name=vomu-postgres', '--filter', 'name=agent-local', '--format', '  {{.Names}}  {{.Status}}']);
  console.log(docker || '  (docker not reachable, or no Juno containers)');
}

function stop() {
  for (const service of SERVICES.filter((s) => STOPPABLE.has(s.port))) {
    const found = listener(service.port);
    if (!found) continue;
    process.kill(found.pid, 'SIGTERM');
    console.log(`SIGTERM pid ${found.pid}  :${service.port}  ${service.name}`);
  }
  console.log('Docker containers (database, sandboxes) are untouched; see README for removing them.');
}

const command = process.argv[2];
if (command === 'status') await status();
else if (command === 'stop') stop();
else {
  console.error('usage: pnpm stack <status|stop>');
  process.exit(2);
}
