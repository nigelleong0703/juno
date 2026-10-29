/**
 * computerd's async process endpoints. Like every screen action they name the requesting agent in
 * `x-agent-id`, resolve the display through the lifecycle control fence (an unknown agent or a user
 * take-over is refused), and NEVER allocate. The handle is scoped to that agent inside the sandbox,
 * so a handle leaked to another agent still fails the seam's scope check.
 */
import type { Hono } from 'hono';
import { ComputerdError } from '@agent-desktop/sandbox-adapters';
import { handle, requireAgent } from './http.js';
import type { ComputerdDeps } from './deps.js';
import { processReadSchema, processStartSchema, processStopSchema, processWriteSchema, jevMcpStartSchema, jevMcpReadSchema, jevMcpWriteSchema, jevMcpStopSchema } from './schema.js';

export function registerProcessRoutes(app: Hono, deps: ComputerdDeps): void {
  const post = (path: string, run: Route) =>
    app.post(path, (c) =>
      handle(c, async (signal) => run(deps, requireAgent(c), signal, await c.req.json().catch(() => undefined))),
    );

  post('/v1/screens/self/processes/start', async (d, agent, signal, raw) => {
    const input = processStartSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'startProcess', input }, signal);
    if (!result.process || result.process.kind !== 'started') throw new ComputerdError('failed', 'provider returned no start result');
    return Response.json(result.process.snapshot);
  });

  post('/v1/screens/self/processes/read', async (d, agent, signal, raw) => {
    const input = processReadSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'readProcess', input }, signal);
    if (!result.process || result.process.kind !== 'read') throw new ComputerdError('failed', 'provider returned no read result');
    return Response.json(result.process.output);
  });

  post('/v1/screens/self/processes/write', async (d, agent, signal, raw) => {
    const input = processWriteSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'writeProcess', input }, signal);
    if (!result.process || result.process.kind !== 'write') throw new ComputerdError('failed', 'provider returned no write result');
    return Response.json(result.process.result);
  });

  post('/v1/screens/self/processes/stop', async (d, agent, signal, raw) => {
    const input = processStopSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'stopProcess', input }, signal);
    if (!result.process || result.process.kind !== 'stop') throw new ComputerdError('failed', 'provider returned no stop result');
    return Response.json(result.process.result);
  });

  post('/v1/screens/self/jevmcp/start', async (d, agent, signal, raw) => {
    jevMcpStartSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'startJevMcp' }, signal);
    if (!result.process || result.process.kind !== 'started') throw new ComputerdError('failed', 'provider returned no start result');
    return Response.json(result.process.snapshot);
  });

  post('/v1/screens/self/jevmcp/read', async (d, agent, signal, raw) => {
    const input = jevMcpReadSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'readJevMcp', input }, signal);
    if (!result.process || result.process.kind !== 'read') throw new ComputerdError('failed', 'provider returned no read result');
    return Response.json(result.process.output);
  });

  post('/v1/screens/self/jevmcp/write', async (d, agent, signal, raw) => {
    const input = jevMcpWriteSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'writeJevMcp', input }, signal);
    if (!result.process || result.process.kind !== 'write') throw new ComputerdError('failed', 'provider returned no write result');
    return Response.json(result.process.result);
  });

  post('/v1/screens/self/jevmcp/stop', async (d, agent, signal, raw) => {
    const input = jevMcpStopSchema.parse(raw);
    const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
    const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'stopJevMcp', input }, signal);
    if (!result.process || result.process.kind !== 'stop') throw new ComputerdError('failed', 'provider returned no stop result');
    return Response.json(result.process.result);
  });
}

type Route = (deps: ComputerdDeps, agent: string, signal: AbortSignal, raw: unknown) => Promise<Response>;
