/**
 * computerd's screen-action API. Every request names the requesting agent in \`x-agent-id\` and
 * computerd resolves the display itself, so a caller can never act on another agent's screen. An
 * action never allocates: the display must already exist, which keeps \`self/ensure\` the only
 * creation path.
 *
 * Read endpoints (computer view, screen listing, take-over) live in \`routes-screens.ts\`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { BrowserDownError, ComputerdError, parseResolution, type ComputerProvider, type ScreenAction, type ScreenActionResult } from '@agent-desktop/sandbox-adapters';
import { screenElementsSchema } from '@agent-desktop/public-contracts';
import type { Lifecycle } from '../modules/computers/lifecycle.js';
import { LOOK, MUTATE, browserAdmission } from '../modules/control/classify.js';
import type { ComputerdDeps } from './deps.js';
import { bindLifecycle, handle, requireAgent } from './http.js';
import {
  browserActionSchema,
  clickSchema,
  fileReadSchema,
  fileWriteSchema,
  keySchema,
  meetActionSchema,
  navigateSchema,
  scrollSchema,
  shellSchema,
  typeSchema,
} from './schema.js';
import { registerScreenRoutes } from './routes-screens.js';
import { registerProcessRoutes } from './routes-processes.js';
import { registerHomeRoutes } from './routes-home.js';
import { registerPackageRoutes } from './routes-packages.js';
import { registerSpaceRoutes } from './routes-spaces.js';
import { registerMacRoutes } from './routes-mac.js';
import { registerCopyRoutes } from './routes-copy.js';
import { registerClipboardRoutes } from './routes-clipboard.js';

export function createComputerApp(deps: ComputerdDeps): Hono {
  const app = new Hono();

  app.use('/v1/*', async (c, next) => {
    bindLifecycle(c, deps.lifecycle);
    if (deps.requireAuth && !authorized(c, deps.token)) {
      return c.json({ code: 'not_allowed', message: 'missing or invalid bearer token' }, 403);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof ComputerdError) return c.json({ code: error.code, message: error.message, ...error.details }, error.httpStatus);
    return c.json({ code: 'failed', message: error instanceof Error ? error.message : 'unknown error' }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // First, so a call marked for the owner's Mac never reaches the sandbox handlers below.
  registerMacRoutes(app, deps);
  registerScreenRoutes(app, deps);
  registerProcessRoutes(app, deps);
  registerHomeRoutes(app, deps);
  registerPackageRoutes(app, deps);
  registerSpaceRoutes(app, deps);
  registerCopyRoutes(app, deps);
  registerClipboardRoutes(app, deps);
  registerActionRoutes(app, deps);
  return app;
}

/**
 * A browser action whose Chromium is gone: forget the cached boot, re-run the display's idempotent boot
 * (it relaunches Chromium on the same profile) and retry once. The result says the browser restarted.
 * Done here, outside the provider's per-binding lock, so the re-boot cannot deadlock against `act`.
 */
async function actWithBrowserRecovery(
  d: ComputerdDeps,
  agent: string,
  binding: Parameters<ComputerProvider['act']>[0],
  displayNo: number,
  action: ScreenAction,
  signal: AbortSignal,
): Promise<ScreenActionResult> {
  try {
    return await d.provider.act(binding, agent, displayNo, action, signal);
  } catch (error) {
    if (!(error instanceof BrowserDownError)) throw error;
  }
  d.provider.invalidateScreen(binding, displayNo);
  const again = await d.lifecycle.requireScreen(agent, signal);
  let result: ScreenActionResult;
  try {
    result = await d.provider.act(again.binding, agent, again.screen.displayNo, action, signal);
  } catch (error) {
    if (error instanceof BrowserDownError) throw new ComputerdError('failed', `the browser on screen ${displayNo} closed and could not be restarted`);
    throw error;
  }
  return result.browser ? { ...result, browser: { ...result.browser, restarted: true } } : result;
}

function registerActionRoutes(app: Hono, deps: ComputerdDeps): void {
  const body = async <T>(c: Context, parse: (value: unknown) => T): Promise<T> => {
    const raw = await c.req.json().catch(() => undefined);
    return parse(raw);
  };

  /** Run an agent action that has no response body. */
  const act = (c: Context, run: Action) =>
    handle(c, async (signal) => {
      await run(deps, requireAgent(c), signal);
      return new Response(null, { status: 204 });
    });

  /** Run an agent action that returns a JSON body. */
  const actJson = (c: Context, run: ActionJson) => handle(c, (signal) => run(deps, requireAgent(c), signal));

  app.post('/v1/screens/self/screenshot', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, LOOK);
      const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'screenshot' }, signal);
      if (!result.screenshot) throw new ComputerdError('failed', 'provider returned no screenshot');
      await d.lifecycle.recordScreenshot(screen, new Date().toISOString());
      return c.json(result.screenshot);
    }),
  );

  app.post('/v1/screens/self/click', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const point = await body(c, (value) => clickSchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'click', point }, signal);
    }),
  );

  app.post('/v1/screens/self/double-click', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const point = await body(c, (value) => clickSchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'doubleClick', point }, signal);
    }),
  );

  app.post('/v1/screens/self/right-click', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const point = await body(c, (value) => clickSchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'rightClick', point }, signal);
    }),
  );

  app.post('/v1/screens/self/move', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const point = await body(c, (value) => clickSchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'move', point }, signal);
    }),
  );

  app.post('/v1/screens/self/type', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const { text } = await body(c, (value) => typeSchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'type', text }, signal);
    }),
  );

  app.post('/v1/screens/self/key', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const { key } = await body(c, (value) => keySchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'key', key }, signal);
    }),
  );

  app.post('/v1/screens/self/scroll', (c) =>
    act(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const input = await body(c, (value) => scrollSchema.parse(value));
      await d.provider.act(binding, agent, screen.displayNo, { kind: 'scroll', input }, signal);
    }),
  );

  app.post('/v1/screens/self/browser/navigate', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, MUTATE);
      const { url } = await body(c, (value) => navigateSchema.parse(value));
      const result = await actWithBrowserRecovery(d, agent, binding, screen.displayNo, { kind: 'navigate', url }, signal);
      if (!result.navigate) throw new ComputerdError('failed', 'provider returned no navigate result');
      return c.json(result.navigate);
    }),
  );

  // Typed DOM actions on the agent's own Chromium via the sandbox-local browser helper.
  // Owner-scoped like every other action: the agent resolves through the lifecycle fence
  // (unknown agent refused, user takeover refused), and the display's CDP port never leaves
  // the sandbox — there is no public CDP proxy.
  app.post('/v1/screens/self/browser/action', (c) =>
    actJson(c, async (d, agent, signal) => {
      const input = await body(c, (value) => browserActionSchema.parse(value));
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal, browserAdmission(input.action));
      const result = await actWithBrowserRecovery(d, agent, binding, screen.displayNo, { kind: 'browser', input }, signal);
      if (!result.browser) throw new ComputerdError('failed', 'provider returned no browser result');
      return c.json(result.browser);
    }),
  );

  // Google Meet attendance (join, state, chat, leave) through the sandbox-local agent-meet helper; same fence as browser/action.
  app.post('/v1/screens/self/browser/meet', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
      const input = await body(c, (value) => meetActionSchema.parse(value));
      const result = await actWithBrowserRecovery(d, agent, binding, screen.displayNo, { kind: 'meet', input }, signal);
      if (!result.meet) throw new ComputerdError('failed', 'provider returned no meet result');
      return c.json(result.meet);
    }),
  );

  // Tap targets of the tab on screen, for the user's own fingers: allowed whoever controls the screen
  // (agentd decides when a client may ask), read-only, and it never allocates a display.
  app.get('/v1/screens/self/elements', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.existingScreen(agent);
      const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'browser', input: { action: 'bounds' } }, signal);
      if (result.browser?.action !== 'bounds') throw new ComputerdError('failed', 'provider returned no bounds result');
      const { width, height } = parseResolution(screen.resolution);
      const elements = result.browser.elements.map(({ rect, role, name }) => ({ rect, role, name }));
      return c.json(screenElementsSchema.parse({ screenId: screen.id, width, height, elements }));
    }),
  );

  app.post('/v1/screens/self/shell/run', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
      const parsed = await body(c, (value) => shellSchema.parse(value));
      const input = {
        command: parsed.command,
        timeoutMs: parsed.timeoutMs ?? 60_000,
        ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
      };
      const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'shell', input }, signal);
      return c.json(result.shell ?? { stdout: '', stderr: '', exitCode: 0 });
    }),
  );

  app.post('/v1/screens/self/files/read', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
      const { path } = await body(c, (value) => fileReadSchema.parse(value));
      const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'readFile', path }, signal);
      return c.json(result.fileRead ?? { content: '', bytes: 0 });
    }),
  );

  app.post('/v1/screens/self/files/write', (c) =>
    actJson(c, async (d, agent, signal) => {
      const { binding, screen } = await d.lifecycle.requireAgentControl(agent, signal);
      const input = await body(c, (value) => fileWriteSchema.parse(value));
      const result = await d.provider.act(binding, agent, screen.displayNo, { kind: 'writeFile', input }, signal);
      return c.json(result.fileWrite ?? { path: input.path, bytes: 0 });
    }),
  );
}

type Action = (deps: ComputerdDeps, agent: string, signal: AbortSignal) => Promise<void>;
type ActionJson = (deps: ComputerdDeps, agent: string, signal: AbortSignal) => Promise<Response>;

function authorized(c: Context, token: string): boolean {
  const header = c.req.header('authorization') ?? '';
  return header === `Bearer ${token}`;
}

export type { ComputerProvider };
export type { Lifecycle };
