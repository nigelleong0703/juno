#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = resolve(ROOT, 'deploy');
const ENV_FILE = resolve(DEPLOY, '.env');
const TEMPLATE = resolve(DEPLOY, '.env.example');
const BASE_COMPOSE = resolve(DEPLOY, 'compose.yml');
const SOCKET_COMPOSE = resolve(DEPLOY, 'compose.local-sandbox.yml');
const SECRET_KEYS = ['POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET', 'INTERNAL_AGENTD_TOKEN', 'ADMIN_TOKEN', 'SECRETS_KEY', 'SCREEN_TICKET_SECRET', 'ARTIFACT_URL_SECRET', 'SPACE_URL_SECRET', 'COMPUTERD_TOKEN'];
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  const options = { up: false, check: false, allowUnconfiguredModel: false, localSandbox: false, project: undefined, model: {} };
  const value = (flag, index) => {
    const result = args[index + 1];
    if (!result || result.startsWith('--')) fail(`${flag} needs a value.`);
    return result;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--up') options.up = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--allow-unconfigured-model') options.allowUnconfiguredModel = true;
    else if (arg === '--local-sandbox') options.localSandbox = true;
    else if (arg === '--project') options.project = value(arg, i++);
    else if (arg === '--model-base-url') options.model.base = value(arg, i++);
    else if (arg === '--model-id') options.model.id = value(arg, i++);
    else if (arg === '--model-key') options.model.key = value(arg, i++);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`Unknown option: ${arg}`);
  }
  if (options.up && options.check) fail('Use either --up or --check, not both.');
  if (!options.up && !options.check && !options.help) options.check = true;
  if (options.project && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project)) fail('--project must be a lowercase Docker Compose project name.');
  for (const value of Object.values(options.model)) if (/[\r\n]/.test(value)) fail('Model settings must not contain line breaks.');
  return options;
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function replaceEnvValues(text, values) {
  const seen = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || values[match[1]] === undefined) return line;
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function makeSecret(name) {
  if (name === 'SECRETS_KEY') return randomBytes(32).toString('base64');
  if (name === 'POSTGRES_PASSWORD') return randomBytes(24).toString('hex');
  if (name === 'BETTER_AUTH_SECRET') return randomBytes(48).toString('base64url');
  return randomBytes(36).toString('base64url');
}

function withEnvLock(action) {
  mkdirSync(DEPLOY, { recursive: true });
  const lock = resolve(DEPLOY, '.env.lock');
  let fd;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
      } catch {}
      Atomics.wait(sleepCell, 0, 0, 100);
    }
  }
  if (fd === undefined) fail('Timed out waiting for deployment configuration lock.');
  try {
    fchmodSync(fd, 0o600);
    action();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch {}
  }
}

function ensureConfig(options) {
  withEnvLock(() => {
    if (!existsSync(TEMPLATE)) fail('deploy/.env.example is missing.');
    let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : readFileSync(TEMPLATE, 'utf8');
    let values = parseEnv(text);
    const updates = {};
    const defaults = parseEnv(readFileSync(TEMPLATE, 'utf8'));
    for (const [key, value] of Object.entries(defaults)) if (values[key] === undefined) updates[key] = value;
    for (const key of SECRET_KEYS) if (!values[key]) updates[key] = makeSecret(key);
    if (!values.DATABASE_URL || !existsSync(ENV_FILE)) {
      const user = values.POSTGRES_USER || 'postgres';
      const password = updates.POSTGRES_PASSWORD || values.POSTGRES_PASSWORD;
      const database = values.POSTGRES_DB || 'agents';
      updates.DATABASE_URL = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@postgres:5432/${encodeURIComponent(database)}`;
    }
    if (options.model.base !== undefined) updates.MODEL_BASE_URL = options.model.base;
    if (options.model.id !== undefined) updates.MODEL_ID = options.model.id;
    if (options.model.key !== undefined) updates.MODEL_API_KEY = options.model.key;
    if (options.project) updates.COMPOSE_PROJECT_NAME = options.project;
    text = replaceEnvValues(text, updates);
    const temp = resolve(DEPLOY, `.env.tmp-${process.pid}`);
    writeFileSync(temp, text, { mode: 0o600, flag: 'w' });
    chmodPrivate(temp);
    renameSync(temp, ENV_FILE);
    chmodPrivate(ENV_FILE);
    values = parseEnv(text);
    if (values.COMPOSE_PROJECT_NAME === undefined) fail('COMPOSE_PROJECT_NAME is missing from deploy/.env.');
  });
}

function chmodPrivate(path) {
  chmodSync(path, 0o600);
}

function envValues() {
  const mode = statSync(ENV_FILE).mode & 0o777;
  if (mode !== 0o600) fail(`deploy/.env must be mode 600; found ${mode.toString(8)}.`);
  return parseEnv(readFileSync(ENV_FILE, 'utf8'));
}

function hostParts(value, name) {
  let parsed;
  try { parsed = new URL(value.includes('://') ? value : `http://${value}`); } catch { fail(`${name} must be a hostname with an optional port.`); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) fail(`${name} must contain only a hostname and optional port.`);
  return { hostname: parsed.hostname.toLowerCase(), port: parsed.port, protocol: parsed.protocol };
}

function siteParts(value, name) {
  let parsed;
  try { parsed = new URL(value.includes('://') ? value : `https://${value}`); } catch { fail(`${name} must be a hostname or URL origin.`); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) fail(`${name} must contain only a hostname and optional scheme/port.`);
  return { hostname: parsed.hostname.toLowerCase(), port: parsed.port, protocol: parsed.protocol };
}

const PUBLIC_SUFFIXES = new Set(['localhost', 'sslip.io', 'nip.io', 'github.io', 'vercel.app', 'pages.dev', 'workers.dev', 'netlify.app', 'co.uk', 'org.uk', 'com.cn', 'com.au', 'co.jp', 'com.hk', 'com.sg']);
function registrableDomain(host) {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.toLowerCase().split('.');
  let suffixLength = 1;
  for (let count = Math.min(3, labels.length); count >= 1; count -= 1) {
    if (PUBLIC_SUFFIXES.has(labels.slice(-count).join('.'))) { suffixLength = count; break; }
  }
  return labels.slice(-(suffixLength + 1)).join('.');
}

function validate(values) {
  const url = new URL(values.BETTER_AUTH_URL || '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('BETTER_AUTH_URL must be a public http(s) origin without a path, credentials, query or fragment.');
  const api = siteParts(values.API_SITE || '', 'API_SITE');
  const artifact = hostParts(values.ARTIFACT_HOST || '', 'ARTIFACT_HOST');
  const artifactSite = siteParts(values.ARTIFACT_SITE || '', 'ARTIFACT_SITE');
  const space = hostParts(values.SPACE_DOMAIN || '', 'SPACE_DOMAIN');
  const spaceSite = siteParts(values.SPACE_WILDCARD || '', 'SPACE_WILDCARD');
  if (api.hostname !== url.hostname.toLowerCase()) fail('API_SITE hostname must match BETTER_AUTH_URL.');
  if (artifact.hostname !== artifactSite.hostname) fail('ARTIFACT_SITE must match ARTIFACT_HOST.');
  if (`*.${space.hostname}` !== spaceSite.hostname) fail('SPACE_WILDCARD must be *.SPACE_DOMAIN.');
  if (api.protocol !== 'http:' && api.protocol !== 'https:') fail('API_SITE has an unsupported scheme.');
  if (api.protocol !== url.protocol) fail('API_SITE and BETTER_AUTH_URL must use the same scheme.');
  if (artifactSite.protocol !== url.protocol || spaceSite.protocol !== url.protocol) fail('All Caddy sites must use the same scheme as BETTER_AUTH_URL.');
  if (url.protocol === 'https:' && (api.port || artifact.port || space.port)) fail('Production https host settings must not include explicit ports.');
  if (url.protocol === 'https:' && (Number(values.EDGE_HTTP_PORT) !== 80 || Number(values.EDGE_HTTPS_PORT) !== 443)) fail('Public https deployment requires EDGE_HTTP_PORT=80 and EDGE_HTTPS_PORT=443.');
  if (url.protocol === 'https:' && values.EDGE_HTTP_BIND !== '0.0.0.0') fail('Public https deployment requires EDGE_HTTP_BIND=EDGE_HTTPS_BIND=0.0.0.0.');
  if (url.protocol === 'http:') {
    const edgePort = Number(values.EDGE_HTTP_PORT);
    for (const [name, host] of [['ARTIFACT_HOST', artifact], ['SPACE_DOMAIN', space]]) {
      if (host.port && Number(host.port) !== edgePort) fail(`${name} port must match EDGE_HTTP_PORT (${edgePort}).`);
      if (!host.port && edgePort !== 80) fail(`${name} must include :${edgePort} to match the public HTTP URL.`);
    }
    if (url.port && Number(url.port) !== edgePort) fail('BETTER_AUTH_URL port must match EDGE_HTTP_PORT.');
    if (!url.port && edgePort !== 80) fail('BETTER_AUTH_URL must include the EDGE_HTTP_PORT.');
  }
  for (const [name, host] of [['ARTIFACT_HOST', artifact.hostname], ['SPACE_DOMAIN', space.hostname]]) {
    if (api.hostname === host || api.hostname.endsWith(`.${host}`)) fail(`${name} must not equal or contain the API hostname.`);
    if (url.protocol === 'https:' && registrableDomain(host) === registrableDomain(api.hostname)) fail(`${name} shares the API registrable domain over HTTPS; use a separate registrable domain.`);
  }
  if (space.hostname === artifact.hostname || artifact.hostname.endsWith(`.${space.hostname}`)) fail('ARTIFACT_HOST must not be a Spaces host under SPACE_DOMAIN.');
  const portNames = ['EDGE_HTTP_PORT', 'EDGE_HTTPS_PORT', 'COMPUTERD_LINK_PORT'];
  for (const key of portNames) {
    const port = Number(values[key]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${key} must be an integer from 1 through 65535.`);
  }
  if (values.EDGE_HTTP_PORT === values.EDGE_HTTPS_PORT) fail('EDGE_HTTP_PORT and EDGE_HTTPS_PORT must be different.');
  if (!['127.0.0.1', '0.0.0.0'].includes(values.EDGE_HTTP_BIND) || values.EDGE_HTTP_BIND !== values.EDGE_HTTPS_BIND) fail('EDGE_HTTP_BIND and EDGE_HTTPS_BIND must both be 127.0.0.1 (loopback) or 0.0.0.0 (public).');
  if ([Number(values.EDGE_HTTP_PORT), Number(values.EDGE_HTTPS_PORT)].some((port) => [5199, 54330, 8787, 8788, 8791, 8795].includes(port))) fail('Public edge ports must not collide with Juno development or internal service ports.');
  if (values.API_HOST !== '0.0.0.0') fail('API_HOST must be 0.0.0.0 inside the app container so Caddy can reach it.');
  if (values.AGENTD_URL !== 'http://127.0.0.1:8788' || values.COMPUTERD_URL !== 'http://127.0.0.1:8791') fail('AGENTD_URL and COMPUTERD_URL must use supervisor loopback URLs.');
  if (values.AUTH_MODE !== 'account') fail('AUTH_MODE must be account for the public server.');
  if (!['./Caddyfile', './Caddyfile.qa'].includes(values.CADDYFILE_PATH)) fail('CADDYFILE_PATH must be ./Caddyfile (public TLS) or ./Caddyfile.qa (loopback HTTP QA); these select files bundled in the edge image.');
  if ((url.protocol === 'https:') !== (values.CADDYFILE_PATH === './Caddyfile')) fail('Use bundled Caddyfile.qa for HTTP QA and bundled Caddyfile for public HTTPS.');
  const db = new URL(values.DATABASE_URL || '');
  if (db.protocol !== 'postgres:' && db.protocol !== 'postgresql:') fail('DATABASE_URL must be a PostgreSQL URL.');
  if (db.hostname !== 'postgres' || db.port !== '5432' || decodeURIComponent(db.username) !== values.POSTGRES_USER || decodeURIComponent(db.password) !== values.POSTGRES_PASSWORD || decodeURIComponent(db.pathname.slice(1)) !== values.POSTGRES_DB) fail('DATABASE_URL credentials/database must match POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB on the compose postgres service.');
  for (const key of SECRET_KEYS) if (!values[key] || values[key].startsWith('replace-with-')) fail(`${key} is missing or still a placeholder; run node deploy/setup.mjs to generate it.`);
  if (Buffer.from(values.SECRETS_KEY, 'base64').length !== 32) fail('SECRETS_KEY must decode to exactly 32 bytes; do not replace an existing production key.');
  if (values.BETTER_AUTH_SECRET.length < 32) fail('BETTER_AUTH_SECRET must contain at least 32 characters.');
  const hasBase = Boolean(values.MODEL_BASE_URL);
  const hasId = Boolean(values.MODEL_ID);
  if (hasBase !== hasId) fail('Set both MODEL_BASE_URL and MODEL_ID, or leave both empty.');
  if (hasBase && !['http:', 'https:'].includes(new URL(values.MODEL_BASE_URL).protocol)) fail('MODEL_BASE_URL must use http(s).');
  for (const origin of (values.AUTH_TRUSTED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) fail(`AUTH_TRUSTED_ORIGINS entries must be origins without paths: ${origin}`);
  }
  const bridge = values.DOCKER_BRIDGE_HOST?.trim();
  if (bridge && (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bridge) || bridge === '127.0.0.1' || bridge === '0.0.0.0')) fail('DOCKER_BRIDGE_HOST must be the non-loopback IPv4 gateway from docker network inspect bridge.');
  if (values.COMPUTER_PROVIDER === 'e2b' && (!values.E2B_API_KEY || !values.E2B_API_URL || !values.E2B_SANDBOX_URL || !values.COMPUTERD_LINK_URL.startsWith('wss://'))) fail('E2B requires E2B_API_KEY, both E2B URLs, and a reachable wss:// COMPUTERD_LINK_URL.');
  return { apiHost: url.hostname.toLowerCase(), hasModel: hasBase && hasId };
}

function composeArgs(values, options, files, command) {
  const project = options.project || values.COMPOSE_PROJECT_NAME || 'juno';
  const args = ['compose', '--project-name', project, '--env-file', ENV_FILE];
  for (const file of files) args.push('-f', file);
  args.push(...command);
  return args;
}

function composeEnv(values, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(values)) delete env[key];
  return { ...env, ...overrides };
}

function run(args, label, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...(options.stdio ? { stdio: options.stdio } : {}),
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed${result.status === null ? '' : ` (exit ${result.status})`}${result.stderr?.trim() ? `: ${result.stderr.trim().slice(-1200)}` : ''}`);
  return result.stdout || '';
}

function composeConfig(values, options, files) {
  const env = composeEnv(values, files.length > 1 && !values.DOCKER_BRIDGE_HOST ? { DOCKER_BRIDGE_HOST: '172.17.0.1' } : {});
  run(['docker', ...composeArgs(values, options, files, ['config', '--quiet'])], `Docker Compose configuration (${files.map((f) => f.split('/').at(-1)).join(' + ')})`, { env });
  const text = run(['docker', ...composeArgs(values, options, files, ['config', '--format', 'json'])], 'Docker Compose inspection', { env });
  try { return JSON.parse(text); } catch { fail('Docker Compose did not return valid JSON.'); }
}

function inspectCompose(values, options) {
  const base = composeConfig(values, options, [BASE_COMPOSE]);
  if (!['postgres', 'migrate', 'app', 'edge'].every((service) => base.services?.[service])) fail('Compose must define postgres, migrate, app and edge services.');
  if (base.services.app.environment.API_HOST !== '0.0.0.0' || base.services.app.environment.AGENTD_URL !== 'http://127.0.0.1:8788' || base.services.app.environment.COMPUTERD_URL !== 'http://127.0.0.1:8791') fail('Compose app wiring does not match the supervisor loopback contract.');
  if (base.services.app.environment.WEB_DIST !== '/app/web-dist') fail('WEB_DIST must point to the built web bundle in the app image.');
  if (!['responses', 'chat'].includes(base.services.app.environment.MODEL_WIRE_API)) fail('MODEL_WIRE_API must resolve to responses or chat; an empty value prevents agentd from starting.');
  if (!['local', 'e2b'].includes(base.services.app.environment.COMPUTER_PROVIDER)) fail('COMPUTER_PROVIDER must resolve to local or e2b.');
  if (base.services.postgres.ports?.length || base.services.app.ports?.length || base.services.migrate.ports?.length) fail('Postgres and application services must not publish host ports.');
  if ((base.services.edge.ports || []).length !== 2) fail('Caddy must own the only two public ports (HTTP and HTTPS).');
  if (base.services.migrate.build?.dockerfile !== 'deploy/Dockerfile' || base.services.app.build?.dockerfile !== 'deploy/Dockerfile') fail('The migrate and app services must build the production server image from deploy/Dockerfile.');
  if (base.services.edge.build?.dockerfile !== 'deploy/Edge.Dockerfile' || base.services.edge.image !== `juno-edge:${values.JUNO_IMAGE_TAG || 'local'}`) fail('The edge service must build the tagged juno-edge image from deploy/Edge.Dockerfile.');
  if (base.services.edge.environment?.CADDYFILE_PATH !== values.CADDYFILE_PATH) fail('The edge service must pass the validated bundled CADDYFILE_PATH to the image.');
  const edgeMounts = base.services.edge.volumes || [];
  if (edgeMounts.some((mount) => mount.type !== 'volume' || mount.source === '.' || mount.source?.includes('Caddyfile'))) fail('The edge service must not bind-mount host files; only named Caddy data/config volumes are allowed.');
  for (const name of ['caddy-data', 'caddy-config']) if (!edgeMounts.some((mount) => mount.type === 'volume' && mount.source === name)) fail(`The edge service must retain the named ${name} volume.`);
  if (!base.services.app.depends_on?.migrate || base.services.app.depends_on.migrate.condition !== 'service_completed_successfully') fail('The app must wait for the one-shot database migration service.');
  composeConfig(values, options, [BASE_COMPOSE, SOCKET_COMPOSE]);
}

function selfCheckSecrets() {
  const directory = resolve(tmpdir(), `juno-deploy-check-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(directory, { mode: 0o700 });
  const path = resolve(directory, '.env');
  try {
    let text = readFileSync(TEMPLATE, 'utf8');
    const first = {};
    for (const key of SECRET_KEYS) first[key] = makeSecret(key);
    text = replaceEnvValues(text, first);
    writeFileSync(path, text, { mode: 0o600 });
    const generated = parseEnv(readFileSync(path, 'utf8'));
    const second = {};
    for (const key of SECRET_KEYS) if (!generated[key]) second[key] = makeSecret(key);
    const after = parseEnv(replaceEnvValues(readFileSync(path, 'utf8'), second));
    if (SECRET_KEYS.some((key) => generated[key] !== after[key])) fail('Secret generation is not idempotent.');
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) fail('Generated secrets file is not mode 600.');
  } finally {
    try { unlinkSync(path); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
}

async function waitForReadiness(base) {
  const until = Date.now() + 180_000;
  let last = 'no response';
  while (Date.now() < until) {
    try {
      const response = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(4000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
  }
  fail(`Deployment did not become ready at ${base}/healthz within 3 minutes (${last}). Inspect with docker compose logs.`);
}

function help() {
  process.stdout.write('Juno server setup\n\nUsage: node deploy/setup.mjs [--check | --up] [options]\n\nOptions:\n  --check                         Generate/check private config and validate Compose\n  --up                            Build, start Postgres, run migrations, start app + Caddy\n  --project NAME                  Use an isolated Compose project name\n  --allow-unconfigured-model      Explicitly allow --up without a platform default model\n  --model-base-url URL            Set MODEL_BASE_URL without editing the env file\n  --model-id ID                   Set MODEL_ID without editing the env file\n  --model-key KEY                 Set MODEL_API_KEY without editing the env file\n  --local-sandbox                 Add the optional Linux Docker socket/bridge overlay\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  ensureConfig(options);
  const values = envValues();
  const status = validate(values);
  selfCheckSecrets();
  inspectCompose(values, options);
  if (options.up && !status.hasModel && !options.allowUnconfiguredModel) fail('No platform model is configured. Set MODEL_BASE_URL and MODEL_ID, or pass --allow-unconfigured-model to start the web/API so an owner can configure a provider in Settings.');
  process.stdout.write('Deployment configuration passed: secrets are stable and mode 600; Compose parses; service loopback, host ports, DB URL, web bundle, migration dependency, auth origins, and isolated content hosts are valid.\n');
  if (!options.up) {
    if (!status.hasModel) process.stdout.write('No platform model is configured. The stack can serve the web/API; agent runs need an owner-configured provider or MODEL_BASE_URL + MODEL_ID. No fake model is used.\n');
    return;
  }
  if (!status.hasModel) process.stdout.write('No platform model is configured. The web/API will start; agent runs require an owner-configured provider in Settings. No model is fabricated.\n');
  const files = [BASE_COMPOSE, ...(options.localSandbox ? [SOCKET_COMPOSE] : [])];
  if (options.localSandbox) {
    if (!values.DOCKER_BRIDGE_HOST) fail('--local-sandbox requires DOCKER_BRIDGE_HOST in deploy/.env. On Linux, use the gateway from: docker network inspect bridge');
    const expected = run(['docker', 'network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], 'Read the Docker bridge gateway').trim();
    if (expected !== values.DOCKER_BRIDGE_HOST) fail(`DOCKER_BRIDGE_HOST (${values.DOCKER_BRIDGE_HOST}) does not match the active bridge gateway (${expected}).`);
  }
  const args = composeArgs(values, options, files, ['up', '-d', '--build']);
  process.stdout.write(`Building and starting Compose project ${options.project || values.COMPOSE_PROJECT_NAME}...\n`);
  run(['docker', ...args], 'Docker Compose up', { env: composeEnv(values), stdio: 'inherit' });
  await waitForReadiness(values.BETTER_AUTH_URL);
  process.stdout.write(`Ready: ${values.BETTER_AUTH_URL}\n`);
  if (options.localSandbox) process.stdout.write('Local computer support is enabled. The Docker socket grants host-level Docker control; keep the bridge-bound link port firewalled to Docker networks.\n');
  else process.stdout.write('Computer creation is lazy. Local computers require the Linux Docker socket overlay; E2B requires its explicit endpoint/key and reachable link URL. No computer image was built.\n');
}

main().catch((error) => {
  process.stderr.write(`deploy setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
