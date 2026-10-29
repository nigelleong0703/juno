// Juno app supervisor: runs api + agentd + computerd in ONE container on the
// container loopback. Product design binds agentd (packages/agentd/src/boot.ts)
// and computerd (packages/computerd/src/main.ts default) to 127.0.0.1, so
// cross-container calls would fail; co-locating them keeps every internal URL
// on 127.0.0.1 with zero product-source changes. Only the api binds 0.0.0.0
// (API_HOST env, supported by packages/api/src/boot.ts) so the edge proxy
// (Caddy, separate container) can reach it. Any child exiting non-zero kills
// the rest and exits non-zero so compose restarts the container.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const BACKEND_DIR = process.env.JUNO_BACKEND_DIR || '/app/backend';
const SERVICES = [
  { name: 'api', cwd: 'packages/api', args: ['--import', 'tsx', 'src/main.ts'] },
  { name: 'agentd', cwd: 'packages/agentd', args: ['--import', 'tsx', 'src/main.ts'] },
  { name: 'computerd', cwd: 'packages/computerd', args: ['--import', 'tsx', 'src/main.ts'] },
];

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function log(name, chunk) {
  const text = String(chunk);
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    process.stdout.write('[' + name + '] ' + line + '\n');
  }
}

function stopAll(signal) {
  for (const [name, child] of children) {
    try { child.kill(signal); } catch (e) { log(name, 'kill failed: ' + (e && e.message ? e.message : e)); }
  }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('supervisor', 'shutting down (' + reason + ')');
  stopAll('SIGTERM');
  const force = setTimeout(() => stopAll('SIGKILL'), 10000);
  if (force.unref) force.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

for (const svc of SERVICES) {
  const child = spawn('node', svc.args, {
    cwd: resolve(BACKEND_DIR, svc.cwd),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(svc.name, child);
  log('supervisor', 'started ' + svc.name + ' (pid ' + child.pid + ')');
  child.stdout.on('data', (c) => log(svc.name, c));
  child.stderr.on('data', (c) => log(svc.name, c));
  child.on('exit', (code, signal) => {
    children.delete(svc.name);
    if (shuttingDown) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    log('supervisor', svc.name + ' exited code=' + code + ' signal=' + signal + '; stopping container');
    exitCode = 1;
    shutdown(svc.name + ' exited');
    const force = setTimeout(() => { stopAll('SIGKILL'); process.exit(1); }, 15000);
    if (force.unref) force.unref();
  });
}
