/**
 * computerd's Spaces endpoints (BACKEND 5.12). Two kinds of caller:
 *  - an agent's runtime (`/v1/screens/self/spaces/...`, x-agent-id): list the busy ports, register an app. Registration
 *    verifies the listener as root from the kernel's socket table; the agent's claim is never trusted.
 *  - the public API (`/v1/spaces/...`, owner only): the gateway's key with the computer resumed and the gateway running, and
 *    whether the computer is up and the apps are listening, for the status shown on the card. The traffic itself is `gateway-proxy.ts`.
 */
import type { Hono } from 'hono';
import type { E2bBinding } from '@agent-desktop/contracts';
import { SPACE_PORTS, failed, httpOverStream, unavailable } from '@agent-desktop/sandbox-adapters';
import { z } from 'zod';
import { handle, requireAgent } from './http.js';
import type { ComputerdDeps } from './deps.js';
import { snapshotCommand } from './spaces-snapshot.js';

const registerSchema = z.object({ spaceId: z.string().min(1), port: z.number().int() });
const statusSchema = z.object({ spaces: z.array(z.string().min(1)).max(500) });
const snapshotSchema = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/) });

export function registerSpaceRoutes(app: Hono, deps: ComputerdDeps): void {
  // Ports already listening in the app range, so a new app is never given one that is taken.
  app.post('/v1/screens/self/spaces/ports', (c) =>
    handle(c, async (signal) => {
      const { binding } = await deps.lifecycle.requireAgentControl(requireAgent(c), signal);
      const ports = await deps.provider.listeningPorts(binding, signal);
      return Response.json({ ports: [...new Set(ports.map((socket) => socket.port))].filter((port) => port >= SPACE_PORTS.first && port <= SPACE_PORTS.last) });
    }),
  );

  app.post('/v1/screens/self/spaces/register', (c) =>
    handle(c, async (signal) => {
      const agentId = requireAgent(c);
      const input = registerSchema.parse(await c.req.json().catch(() => undefined));
      const { binding } = await deps.lifecycle.requireAgentControl(agentId, signal);
      await deps.provider.registerSpace(binding, { agentId, spaceId: input.spaceId, port: input.port, gatewayKey: deps.lifecycle.gatewayKey(binding.sandboxId) }, signal);
      return Response.json({ computerId: binding.sandboxId });
    }),
  );

  // Computers whose gateway key this process has installed; the first request after a start installs it (and starts the gateway if needed).
  const keyed = new Set<string>();
  /** Does the gateway answer `/__health` with this key? Asked through the computer link, the only way in. */
  const answers = async (binding: E2bBinding, key: string, signal: AbortSignal, passive = false) => {
    try {
      const reply = await httpOverStream(() => deps.provider.gatewayStream(binding, signal, { passive }), '/__health', { headers: { 'x-juno-gateway-key': key } });
      return reply.status === 200;
    } catch {
      return false;
    }
  };

  // The computer behind the gateway, ready: a suspended computer is resumed by asking (this is real traffic); a gateway that does not answer is started again first.
  // The gateway itself is reached through `/v1/spaces/gateway-proxy/` (gateway-proxy.ts), not by an address.
  app.post('/v1/spaces/gateway', (c) =>
    handle(c, async (signal) => {
      const binding = deps.lifecycle.currentBinding();
      if (binding === null) throw unavailable('this account has no computer');
      const key = deps.lifecycle.gatewayKey(binding.sandboxId);
      if (!keyed.has(binding.sandboxId) || !(await answers(binding, key, signal))) {
        await deps.provider.ensureSpaceGateway(binding, key, signal);
        if (!(await answers(binding, key, signal))) throw failed('the Spaces gateway does not answer');
        keyed.add(binding.sandboxId);
      }
      return Response.json({ key, computerId: binding.sandboxId });
    }),
  );

  // Status for the cards. Never resumes, renews or starts anything: a computer without a live sample is paused (or gone), and the
  // running gateway is asked through a passive link stream. A gateway that does not answer means "not listening", not a restart.
  app.post('/v1/spaces/status', (c) =>
    handle(c, async (signal) => {
      const { spaces } = statusSchema.parse(await c.req.json().catch(() => undefined));
      const binding = deps.lifecycle.currentBinding();
      if (binding === null) return Response.json({ computer: 'none', listening: [] });
      if ((await deps.provider.metrics(binding, signal)) === null) return Response.json({ computer: 'paused', listening: [] });
      try {
        const status = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
        const reply = await httpOverStream(() => deps.provider.gatewayStream(binding, status, { passive: true }), '/__status', { headers: { 'x-juno-gateway-key': deps.lifecycle.gatewayKey(binding.sandboxId) } });
        const body: unknown = reply.status === 200 ? reply.json() : undefined;
        const up = typeof body === 'object' && body !== null && 'listening' in body && Array.isArray(body.listening) ? body.listening.filter((id): id is string => typeof id === 'string') : [];
        return Response.json({ computer: 'running', listening: spaces.filter((id) => up.includes(id)) });
      } catch {
        return Response.json({ computer: 'running', listening: [] });
      }
    }),
  );

  // The pages and data of a published app, read as root from its folder for the hosted copy (BACKEND 5.12, option B). Read-only.
  app.post('/v1/spaces/snapshot', (c) =>
    handle(c, async (signal) => {
      const { slug } = snapshotSchema.parse(await c.req.json().catch(() => undefined));
      const binding = deps.lifecycle.currentBinding();
      if (binding === null) throw unavailable('this account has no computer');
      const reply = await deps.provider.withRuntime(binding, signal, (runtime) => runtime.run(snapshotCommand(slug), { timeoutMs: 60_000, signal }));
      if (reply.exitCode !== 0) throw failed(reply.stderr.trim().split('\n').pop() || 'the Space could not be read');
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(reply.stdout);
      } catch {
        throw failed('the Space snapshot is not JSON');
      }
      return Response.json(snapshot);
    }),
  );
}
