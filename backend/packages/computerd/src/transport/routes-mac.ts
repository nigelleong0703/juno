/**
 * The agent actions that can act on the owner's Mac instead of the sandbox. The runner marks such a call with
 * `x-computer: mac` (the agent chose My Mac); everything else on these paths keeps the sandbox default. A Mac header
 * never falls through to a sandbox handler: unsupported Mac routes are refused here.
 */
import type { Context, Hono } from 'hono';
import { ComputerdError, browserResultSchema, failed, notAllowed } from '@agent-desktop/sandbox-adapters';
import type { ComputerdDeps } from './deps.js';
import {
  browserActionSchema,
  fileReadSchema,
  fileWriteSchema,
  macActSchema,
  macAppsResultSchema,
  macAppsSchema,
  macAudioResultSchema,
  macAudioSchema,
  macDesktopResultSchema,
  macSnapshotSchema,
  macVerifySchema,
  navigateSchema,
  processReadSchema,
  processStartSchema,
  processStopSchema,
  processWriteSchema,
  shellSchema,
} from './schema.js';
import { requireAgent } from './http.js';

export const COMPUTER_TARGET_HEADER = 'x-computer';

const MAC_ROUTES: ReadonlySet<string> = new Set([
  'GET /v1/screens/self/environment',
  'POST /v1/screens/self/mac/snapshot',
  'POST /v1/screens/self/mac/act',
  'POST /v1/screens/self/mac/verify',
  'POST /v1/screens/self/browser/navigate',
  'POST /v1/screens/self/browser/action',
  'POST /v1/screens/self/audio',
  'GET /v1/screens/self/permissions',
  'POST /v1/screens/self/mac-apps',
  'POST /v1/screens/self/shell/run',
  'POST /v1/screens/self/files/read',
  'POST /v1/screens/self/files/write',
  'POST /v1/screens/self/processes/start',
  'POST /v1/screens/self/processes/read',
  'POST /v1/screens/self/processes/write',
  'POST /v1/screens/self/processes/stop',
  'POST /v1/screens/self/computer/copy',
]);

export function registerMacRoutes(app: Hono, deps: ComputerdDeps): void {
  app.use('/v1/screens/self/*', async (c, next) => {
    if (c.req.header(COMPUTER_TARGET_HEADER) !== 'mac') return next();
    const route = c.req.method.toUpperCase() + ' ' + c.req.path;
    if (!MAC_ROUTES.has(route)) {
      return c.json({ code: 'bad_request', message: 'this action is not supported on the Mac; no sandbox fallback was used' }, 400);
    }
    return next();
  });

  const onMac = (path: string, method: 'get' | 'post', run: (mac: NonNullable<ComputerdDeps['mac']>, agent: string, signal: AbortSignal, raw: unknown) => Promise<unknown>) => {
    app.use(path, async (c, next) => {
      if (c.req.method.toLowerCase() !== method || c.req.header(COMPUTER_TARGET_HEADER) !== 'mac') return next();
      const mac = deps.mac;
      if (!mac) throw notAllowed('My Mac is not available on this deployment');
      const controller = new AbortController();
      c.req.raw.signal.addEventListener('abort', () => controller.abort());
      const raw = method === 'post' ? await c.req.json().catch(() => undefined) : undefined;
      try {
        return c.json(await run(mac, requireAgent(c), controller.signal, raw) ?? {});
      } catch (error) {
        return mapError(c, error);
      }
    });
  };

  onMac('/v1/screens/self/environment', 'get', (mac, _agent, signal) => mac.environment(signal));
  onMac('/v1/screens/self/mac/snapshot', 'post', async (mac, agent, signal, raw) => macDesktopResultSchema.parse(await mac.desktop(agent, 'snapshot', macSnapshotSchema.parse(raw), signal)));
  onMac('/v1/screens/self/mac/act', 'post', async (mac, agent, signal, raw) => macDesktopResultSchema.parse(await mac.desktop(agent, 'act', macActSchema.parse(raw), signal)));
  onMac('/v1/screens/self/mac/verify', 'post', async (mac, agent, signal, raw) => macDesktopResultSchema.parse(await mac.desktop(agent, 'verify', macVerifySchema.parse(raw), signal)));
  onMac('/v1/screens/self/browser/navigate', 'post', async (mac, agent, signal, raw) => {
    return browserResultSchema.parse(await mac.desktop(agent, 'browser', { action: 'navigate', ...navigateSchema.parse(raw) }, signal));
  });
  onMac('/v1/screens/self/browser/action', 'post', async (mac, agent, signal, raw) => {
    return browserResultSchema.parse(await mac.desktop(agent, 'browser', browserActionSchema.parse(raw), signal));
  });
  onMac('/v1/screens/self/audio', 'post', async (mac, agent, signal, raw) => {
    const input = macAudioSchema.parse(raw);
    return macAudioResultSchema.parse(await mac.desktop(agent, input.action === 'start' ? 'audio_start' : 'audio_stop', input.action === 'start'
      ? { ...(input.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: input.maxDurationSeconds }) }
      : { recordingId: input.recordingId }, signal));
  });
  onMac('/v1/screens/self/permissions', 'get', (mac, agent, signal) => mac.desktop(agent, 'permissions', {}, signal));
  onMac('/v1/screens/self/mac-apps', 'post', async (mac, agent, signal, raw) => macAppsResultSchema.parse(await mac.desktop(agent, 'mac_apps', macAppsSchema.parse(raw), signal)));
  onMac('/v1/screens/self/shell/run', 'post', (mac, _agent, signal, raw) => {
    const parsed = shellSchema.parse(raw);
    return mac.shell({ command: parsed.command, timeoutMs: parsed.timeoutMs ?? 60_000, ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }) }, signal);
  });
  onMac('/v1/screens/self/files/read', 'post', (mac, _agent, signal, raw) => mac.readFile(fileReadSchema.parse(raw).path, signal));
  onMac('/v1/screens/self/files/write', 'post', (mac, _agent, signal, raw) => mac.writeFile(fileWriteSchema.parse(raw), signal));
  onMac('/v1/screens/self/processes/start', 'post', (mac, agent, signal, raw) => mac.processes.start(agent, processStartSchema.parse(raw), signal));
  onMac('/v1/screens/self/processes/read', 'post', (mac, agent, signal, raw) => mac.processes.read(agent, processReadSchema.parse(raw), signal));
  onMac('/v1/screens/self/processes/write', 'post', (mac, agent, signal, raw) => mac.processes.write(agent, processWriteSchema.parse(raw), signal));
  onMac('/v1/screens/self/processes/stop', 'post', (mac, agent, signal, raw) => mac.processes.stop(agent, processStopSchema.parse(raw), signal));
}

function mapError(c: Context, error: unknown): Response {
  if (error instanceof ComputerdError) return c.json({ code: error.code, message: error.message, ...error.details }, error.httpStatus);
  if (error instanceof Error && error.name === 'ZodError') return c.json({ code: 'failed', message: error.message }, 400);
  const wrapped = failed(error instanceof Error ? error.message : 'unknown error');
  return c.json({ code: wrapped.code, message: wrapped.message }, wrapped.httpStatus);
}
