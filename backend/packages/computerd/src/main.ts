/**
 * computerd entry point: the sandbox executor and VNC bridge.
 *
 * It holds the owner's one VM, allocates one display per agent, serves the runner's screen-action
 * API and terminates the authenticated VNC websocket. \`FakeProvider\` is available for tests and
 * for a deployment with no E2B server, but it is never the default.
 */
import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { createMemoryStore, createStore } from '@agent-desktop/db';
import { createLogger } from '@agent-desktop/log';
import { platformSkillsDir } from '@agent-desktop/memory-graph/skills';
import type { Store } from '@agent-desktop/contracts';
import {
  createE2bProvider,
  createFakeProvider,
  createLinkHub,
  computerSize,
  computerStorage,
  createComputerStorage,
  createDockerCli,
  createLocalProvider,
  createSkillsBundleSource,
  createSkillsRollout,
  deploymentId,
  loadComputerConfig,
} from '@agent-desktop/sandbox-adapters';
import { objectDeleter } from './infrastructure/object-storage.js';
import { runOrphanSweep } from './modules/computers/orphan-sweep.js';
import { createOwnerComputers } from './modules/computers/owner-computers.js';
import { createMacComputers } from './modules/mac/mac-computer.js';
import { createMacControlLink } from './modules/mac/control-link.js';
import { createMacRegistry, isMacLink } from './modules/mac/registry.js';
import { createOwnerComputerApp } from './transport/owner-routes.js';
import { createGatewayProxy } from './transport/gateway-proxy.js';
import { createLinkServer } from './transport/link-endpoint.js';
import { createVncProxy } from './transport/proxy.js';
import { createVoxlProxy } from './transport/voxl-proxy.js';

const log = createLogger({ service: 'computerd' });

async function main(): Promise<void> {
  const config = loadComputerConfig();
  // E39: no built-in secrets; refuse to boot instead of serving with an empty bearer or ticket key.
  for (const name of ['COMPUTERD_TOKEN', 'SCREEN_TICKET_SECRET'] as const) {
    if (!config[name]) throw new Error(name + ' is required: computerd has no built-in default');
  }
  const databaseUrl = process.env['DATABASE_URL'] ?? '';
  const store: Store = databaseUrl ? await createStore(databaseUrl) : createMemoryStore();

  const isLocal = config.COMPUTER_PROVIDER === 'local';
  const storageSettings = computerStorage(config);
  // The metadata database is not the app's; computerd creates each user's schema in it (the computer never gets admin rights).
  const metaSql = storageSettings.kind === 'juicefs' && storageSettings.metaUrl.startsWith('postgres') ? postgres(storageSettings.metaUrl) : undefined;
  const storage = createComputerStorage(storageSettings, {
    ...(metaSql ? {
      prepareMeta: async (schema: string) => void (await metaSql`create schema if not exists ${metaSql(schema)}`),
      dropMeta: async (schema: string) => void (await metaSql`drop schema if exists ${metaSql(schema)} cascade`),
    } : {}),
    deleteObjects: objectDeleter(config),
  });
  const size = computerSize(config);
  // The computer link (BACKEND §7.11): computers dial in; their tokens derive from the service secret. A new computer dials
  // COMPUTERD_LINK_URL: `host.docker.internal` for local Docker, an explicit wss:// address for everything else.
  // Macs that joined as computers (My Mac) are registered per owner; an unpaired Mac's link id is refused even though its token still derives.
  const macRegistry = createMacRegistry(resolve(process.env['MAC_REGISTRY_FILE'] ?? '.data/mac-links.json'));
  // A Mac's Stop / resume (pressed on the Mac) reaches the control gateway through the hub; `computers` is built just below and only used when a Mac speaks.
  const macControl = createMacControlLink({ registry: macRegistry, control: (owner) => computers.forOwner(owner).lifecycle.control, log: (fields, message) => log.warn(fields, message) });
  const hub = createLinkHub({ secret: config.COMPUTERD_TOKEN, withdrawn: macRegistry.withdrawn, requireDeclaration: isMacLink, log: (fields, message) => log.info(fields, message), onLinkUp: (linkId) => skillsOnLinkUp(linkId), ...macControl });
  const linkUrl = config.COMPUTERD_LINK_URL || `ws://host.docker.internal:${config.COMPUTERD_LINK_PORT}/v1/computer-link`;
  if (!isLocal && config.COMPUTER_PROVIDER !== 'fake' && config.COMPUTERD_LINK_URL === '') {
    throw new Error('COMPUTERD_LINK_URL is required: the address (wss://…/v1/computer-link) computers dial to reach computerd');
  }
  // Local keeps its own binding/pool namespace so it never shares the E2B binding file.
  // Explicit COMPUTER_BINDING_FILE / SCREEN_REGISTRY_FILE still win when set.
  // Absolute so the path does not depend on the process cwd (pnpm runs the app from its own dir).
  const defaultBindingFile = isLocal ? '.data/local-computer/computerd-binding.json' : '.data/computerd-binding.json';
  const bindingFile = resolve(process.env['COMPUTER_BINDING_FILE'] ?? defaultBindingFile);
  const poolFile = config.SCREEN_REGISTRY_FILE ? resolve(config.SCREEN_REGISTRY_FILE) : join(dirname(bindingFile), 'screen-pool.json');
  // The platform skills every computer is brought to (BACKEND §5.11b): the deployed repository's copy, the same one agentd seeds from.
  // A deploy restarts computerd; every computer's link redials, and each stored (not Mac) computer is checked against the new version then.
  // The providers use the same rollout for a new computer and a resume.
  const skills = createSkillsRollout({ hub, bundle: createSkillsBundleSource(platformSkillsDir()), log: (fields, message) => log.info(fields, message) });
  const skillsOnLinkUp = (linkId: string): void => {
    if (computers.boundLinkIds().has(linkId)) void skills.ensure(linkId, linkId.slice(0, 12), { verify: true });
  };
  const deployment = deploymentId(config.COMPUTERD_DEPLOYMENT_ID, config.COMPUTERD_TOKEN);
  const computers = createOwnerComputers({
    store,
    legacyOwnerId: config.OWNER_ID,
    bindingFile,
    poolFile,
    legacyBinding: isLocal ? null : config.E2B_SANDBOX_ID ? { sandboxId: config.E2B_SANDBOX_ID, template: config.E2B_TEMPLATE } : null,
    providerForOwner: (owner, hooks) => {
      if (config.COMPUTER_PROVIDER === 'fake') return createFakeProvider({ sandboxId: `fake-${randomUUID()}` });
      if (isLocal) return createLocalProvider({ ownerId: owner, image: config.LOCAL_SANDBOX_IMAGE, storage, hub, linkUrl, deployment, onStarted: hooks.onStarted, skills, screenStream: config.SCREEN_STREAM });
      return createE2bProvider({
        template: config.E2B_TEMPLATE,
        apiKey: config.E2B_API_KEY,
        apiUrl: config.E2B_API_URL,
        sandboxUrl: config.E2B_SANDBOX_URL,
        timeoutMs: config.COMPUTER_TIMEOUT_MS,
        idlePauseMinutes: config.COMPUTER_IDLE_PAUSE_MINUTES,
        ownerId: owner,
        hub,
        linkUrl,
        onStarted: hooks.onStarted,
        skills,
        screenStream: config.SCREEN_STREAM,
        ...(storage.kind === 'none' ? {} : { storage: { ownerId: owner, storage } }),
      });
    },
    secret: config.COMPUTERD_TOKEN,
    host: {
      template: isLocal ? config.LOCAL_SANDBOX_IMAGE : config.E2B_TEMPLATE,
      resolution: config.COMPUTER_RESOLUTION,
      timezone: config.COMPUTER_TIMEZONE,
      timeoutMs: config.COMPUTER_TIMEOUT_MS,
      ramGb: size.ramGb,
      vcpu: size.vcpu,
      idlePauseMinutes: config.COMPUTER_IDLE_PAUSE_MINUTES,
    },
  });

  const macLinkUrl = config.COMPUTERD_MAC_LINK_URL || config.COMPUTERD_LINK_URL || `ws://localhost:${config.COMPUTERD_LINK_PORT}/v1/computer-link`;
  const app = createOwnerComputerApp({
    computers,
    token: config.COMPUTERD_TOKEN,
    runtime: () => ({ kind: isLocal ? 'docker' : 'cloud', image: { state: 'ready' } }),
    skills,
    mac: { registry: macRegistry, computers: createMacComputers({ hub, registry: macRegistry, control: (owner) => computers.forOwner(owner).lifecycle.control }), tokenFor: hub.tokenFor, url: macLinkUrl, drop: hub.drop },
  });
  // The public API reaches a computer's Spaces gateway through here, over the computer link (no port is published).
  const gatewayProxy = createGatewayProxy({
    token: config.COMPUTERD_TOKEN,
    scopeFor: (owner) => {
      const { lifecycle, provider } = computers.forOwner(owner);
      return { provider, currentBinding: () => lifecycle.currentBinding() };
    },
    log: (fields, message) => log.info(fields, message),
  });
  // Private deployment: bind loopback by default; explicit COMPUTERD_HOST may override
  // for an authenticated private-network deployment. Never default to 0.0.0.0.
  const host = process.env['COMPUTERD_HOST'] || '127.0.0.1';
  const respond = getRequestListener(app.fetch);
  // voxl's HTTP and WebSocket for the API's screen host (BACKEND 7.1b); declared before `server`, which routes to it, and given its keep-alive below.
  const voxlHolder: { proxy?: ReturnType<typeof createVoxlProxy> } = {};
  const server = createServer((request, response) => {
    if (gatewayProxy.matches(request.url)) return gatewayProxy.handleRequest(request, response);
    if (voxlHolder.proxy?.matches(request.url)) return voxlHolder.proxy.handleRequest(request, response);
    void respond(request, response);
  });
  server.listen(config.COMPUTERD_PORT, host, () => {
    log.info({ host, port: config.COMPUTERD_PORT, provider: config.COMPUTER_PROVIDER }, 'computerd listening');
  });
  // Computers dial this listener, so it may face their network while the API above stays on loopback.
  const linkServer = createLinkServer(hub);
  linkServer.listen(config.COMPUTERD_LINK_PORT, config.COMPUTERD_LINK_HOST, () => {
    log.info({ host: config.COMPUTERD_LINK_HOST, port: config.COMPUTERD_LINK_PORT }, 'computer link listening');
  });
  // Links that were up before this point (none after a restart; the check is cheap) get the same version check as a redial.
  for (const linkId of hub.linked()) skillsOnLinkUp(linkId);

  // An open screen stream (watching or driving) renews its hold on the computer this often, so a screen someone looks at is never
  // mistaken for idleness (BACKEND §7.3b). 0 when idle pausing is off.
  const idleWindow = config.COMPUTER_IDLE_PAUSE_MINUTES > 0
    ? Math.min(config.COMPUTER_IDLE_PAUSE_MINUTES * 60_000, config.COMPUTER_TIMEOUT_MS)
    : 0;
  const keepAliveMs = idleWindow > 0 ? Math.max(15_000, Math.floor(idleWindow / 3)) : 0;

  const proxy = createVncProxy({
    forOwner: (owner) => computers.forOwner(owner),
    // Must match agentd's SCREEN_TICKET_SECRET: agentd signs the ticket, computerd verifies it.
    secret: config.SCREEN_TICKET_SECRET,
    keepAliveMs,
    log: (fields, message) => log.info(fields, message),
  });
  voxlHolder.proxy = createVoxlProxy({
    forOwner: (owner) => computers.forOwner(owner),
    token: config.COMPUTERD_TOKEN,
    secret: config.SCREEN_TICKET_SECRET,
    keepAliveMs,
    log: (fields, message) => log.info(fields, message),
  });
  server.on('upgrade', (request, socket, head) => {
    if (gatewayProxy.matches(request.url)) return gatewayProxy.handleUpgrade(request, socket, head);
    if (voxlHolder.proxy?.matches(request.url)) return voxlHolder.proxy.handleUpgrade(request, socket, head);
    proxy.handleUpgrade(request, socket, head);
  });

  // Local Docker only: containers outlive a computerd that is gone, so each start (and every ten minutes) cleans up after the dead ones.
  if (isLocal) {
    const accountsSql = databaseUrl.startsWith('postgres') ? postgres(databaseUrl, { max: 1 }) : undefined;
    const accountOwners = async (): Promise<string[] | null> => {
      if (!accountsSql) return null;
      const rows = await accountsSql<{ id: string }[]>`select id from auth_user`;
      return [...rows.map((row) => row.id), ...(config.OWNER_ID === '' ? [] : [config.OWNER_ID])];
    };
    const cli = createDockerCli();
    const sweep = () => runOrphanSweep({ cli, computers, deployment, accountOwners, log: (fields, message) => log.info(fields, message) }).catch((error) => log.warn({ err: error }, 'orphan sweep failed'));
    void sweep();
    setInterval(() => void sweep(), 10 * 60_000).unref();
  }

  const shutdown = () => {
    log.info('computerd shutting down');
    hub.close();
    linkServer.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error) => {
  log.error({ err: error }, 'computerd failed to start');
  process.exit(1);
});
