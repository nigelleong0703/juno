/**
 * computerd's screen/computer read endpoints (the thin half of the internal API): the owner-visible
 * computer view, screen listing, take-over/return-control and explicit display allocation. Actions
 * live in \`routes.ts\`; both register on the same Hono app.
 */
import type { Context, Hono } from 'hono';
import { controlActorSchema, type ControlActor, type ScreenResponse } from '@agent-desktop/contracts';
import { handle, requireAgent } from './http.js';
import type { ComputerdDeps } from './deps.js';

/** The person acting, from the headers agentd sets; anything unknown is a plain API call. */
function actorOf(c: Context): ControlActor {
  const parsed = controlActorSchema.safeParse({ via: c.req.header('x-actor-via') ?? 'api', ...(c.req.header('x-actor-id') ? { userId: c.req.header('x-actor-id') } : {}) });
  return parsed.success ? parsed.data : { via: 'api' };
}

function expectedEpoch(c: Context): number | undefined {
  const raw = c.req.header('x-expect-epoch');
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** The owner-visible computer projection, assembled from the real sandbox and the screen rows. */
export interface ComputerView {
  sandboxId: string;
  template: string;
  screens: ScreenResponse[];
  metrics: {
    memUsedMb: number;
    memTotalMb: number;
    vcpu: number;
    cpuPercent: number;
    diskUsedGb: number;
    diskTotalGb: number;
  } | null;
}

export function registerScreenRoutes(app: Hono, deps: ComputerdDeps): void {
  // Owner-visible view of the shared VM: the binding plus the real resource sample and screens.
  app.get('/v1/computer', (c) =>
    handle(c, async (signal) => {
      const binding = await deps.lifecycle.ensureComputer(signal);
      const metrics = await deps.provider.metrics(binding, signal);
      const screens = await deps.lifecycle.listScreens();
      const view: ComputerView = { sandboxId: binding.sandboxId, template: binding.template, screens, metrics };
      return c.json(view);
    }),
  );

  app.post('/v1/computer/pause', (c) =>
    handle(c, async (signal) => {
      await deps.lifecycle.pause(signal);
      return c.json({ state: 'paused' });
    }),
  );

  app.post('/v1/computer/resume', (c) =>
    handle(c, async (signal) => {
      await deps.lifecycle.resume(signal);
      return c.json({ state: 'running' });
    }),
  );

  app.get('/v1/screens', (c) =>
    handle(c, async () => c.json({ items: await deps.lifecycle.listScreens() })),
  );

  // Explicit allocation for one agent's display. This is the only path that starts a new screen; a
  // per-agent action route never allocates, so an unknown x-agent-id cannot conjure a display.
  app.post('/v1/screens/self/ensure', (c) =>
    handle(c, async (signal) => {
      const agent = requireAgent(c);
      return c.json(await deps.lifecycle.ensureScreen(agent, signal));
    }),
  );

  app.get('/v1/screens/self', (c) =>
    handle(c, async () => {
      const screen = await deps.lifecycle.getScreen(requireAgent(c));
      if (!screen) return c.json({ code: 'no_screen', message: 'this agent has no screen yet' }, 404);
      return c.json(screen);
    }),
  );
  // Read-only environment for run context and path resolution. Like the screen GET above it
  // verifies the agent and the existing binding, but it never allocates, leases or pins: an
  // agent without a screen gets a truthful no_screen instead of a fresh display.
  app.get('/v1/screens/self/environment', (c) =>
    handle(c, async (signal) => c.json(await deps.lifecycle.readEnvironment(requireAgent(c), signal))),
  );

  // The person's take-over / hand-back. `changed` and `handBack` are only on the call that really moved control; `x-expect-epoch` (the
  // `controlEpoch` the client saw) makes a stale tap a no-op. The person is named by `x-actor-id` / `x-actor-via` (set by agentd).
  app.post('/v1/screens/self/take-over', (c) =>
    handle(c, async () => c.json(await deps.lifecycle.takeOver(requireAgent(c), actorOf(c), expectedEpoch(c)))),
  );

  app.post('/v1/screens/self/return-control', (c) =>
    handle(c, async () => c.json(await deps.lifecycle.returnControl(requireAgent(c), actorOf(c), expectedEpoch(c)))),
  );

  // The control row of a surface (`screen:<id>`): who holds it, since when, and the newest hand-back (what agentd tells the agent).
  app.get('/v1/controls/:kind/:id', (c) =>
    handle(c, async () => {
      const id = c.req.param('id');
      if (c.req.param('kind') === 'mac') return c.json(await deps.lifecycle.control.get({ kind: 'mac', macId: id }));
      const screen = await deps.lifecycle.findById(id);
      if (!screen) return c.json({ code: 'no_screen', message: 'unknown screen' }, 404);
      return c.json(await deps.lifecycle.control.get({ kind: 'screen', screenId: screen.id }, screen.agentId));
    }),
  );

  // By screen id: used by agentd, which resolves a public \`/v1/screens/:id/...\` call to the agent
  // first. Registered last so the literal \`self\` routes above win.
  app.get('/v1/screens/:id', (c) =>
    handle(c, async () => {
      const screen = await deps.lifecycle.screenById(c.req.param('id'));
      if (!screen) return c.json({ code: 'no_screen', message: 'unknown screen' }, 404);
      return c.json(screen);
    }),
  );
}
