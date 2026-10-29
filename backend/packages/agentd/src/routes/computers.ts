/**
 * Public computer + screen API (SB1). agentd never talks to E2B: every route proxies computerd with
 * the shared service token and the owning agent id, then remaps ids and secrets for the app.
 *
 * Two rules the app depends on:
 *  - one public computer id: every \`ScreenResponse\` carries the \`computers\` row id, never the E2B
 *    sandbox id, so the UI never sees two ids for the same machine;
 *  - write vs watch: a stream ticket is writable only when the caller asked for control AND the
 *    screen's controller is the user. A watcher cannot become writable by the user taking over.
 */
import { type Hono } from 'hono';
import type { Context } from 'hono';
import { NotFoundError } from '@agent-desktop/contracts';
import type { ScreenResponse, Store } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { signScreenTicket } from '@agent-desktop/sandbox-adapters';
import { MAX_UPLOAD_BYTES, screenClipboardPasteSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import { getConfig } from '../config.js';
import { ComputerdClientError, type ComputerdClient, type ControlRequest } from '../computerd.js';
import { computerIdFor, ensureComputer, remapScreen } from './computer-projection.js';
import { canMutateAgent } from './relationships.js';
import { announceControl, approveComputerRequests, pendingComputerRequests } from './control-notices.js';
import type { AgentdDeps } from './index.js';

export interface ScreenRoutesDeps extends AgentdDeps {
  computerd: ComputerdClient;
}

/** A clipboard paste's JSON: base64 (4 characters per 3 bytes) of at most the upload limit, plus a little for the JSON around it. */
const CLIPBOARD_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

/** The controller change already happened; a failed note must not turn it into a 500. */
const noteFailed = (error: unknown): void => {
  createLogger({ service: 'agentd' }).warn({ err: error }, 'screen control note failed');
};

/** Who is taking or handing back (for the audit), and the epoch the client saw (a stale tap changes nothing). */
function controlRequest(c: Context, ownerId: string): ControlRequest {
  const epoch = c.req.header('x-expect-epoch');
  return { actorId: ownerId, via: 'api', ...(epoch !== undefined && /^\d+$/.test(epoch) ? { expectEpoch: Number(epoch) } : {}) };
}

export function registerComputers(app: Hono, deps: ScreenRoutesDeps): void {
  const client = deps.computerd;
  const signal = () => new AbortController().signal;

  const fail = (c: Context, error: unknown): Response => {
    if (error instanceof ComputerdClientError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return c.json({ error: { code: error.code, message: error.message } }, status as 400);
    }
    throw error;
  };

  const action = async (c: Context, run: () => Promise<unknown>): Promise<Response> => {
    try {
      return c.json(await run());
    } catch (error) {
      return fail(c, error);
    }
  };

  /** computerd's screens, each remapped onto the one public computer id. */
  const publicScreens = async (ownerId: string) => {
    const [screens, computerId] = await Promise.all([client.screens(signal()), computerIdFor(deps.store, ownerId)]);
    return screens.map((screen) => remapScreen(screen, computerId, ownerId));
  };

  app.get('/v1/computers', async (c) => {
    const page = await deps.store.list('computers', { limit: 20 });
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });

  app.get('/v1/computers/:id', async (c) => {
    const computer = await deps.store.get('computers', c.req.param('id'));
    if (!computer) throw new NotFoundError('computers', c.req.param('id'));
    return c.json(computer);
  });

  /**
   * Create-or-connect the owner's shared VM and return its projected Computer row. When the caller
   * names an agent, that agent's own display is allocated and its binding persisted, so the app can
   * immediately show the requested agent on the machine. An agent the owner cannot use is refused
   * before any provider call: a rejected request never allocates a sandbox screen.
   */
  app.post('/v1/computers/ensure', (c) =>
    action(c, async () => {
      const ownerId = getOwnerId(c);
      const requested = await readAgentId(c);
      if (requested.status === 'invalid') throw new ComputerdClientError(400, 'invalid_agent_id', 'agentId must be a non-empty string');
      const agentId = requested.status === 'agent' ? requested.agentId : undefined;
      if (agentId && !(await ownsAgent(deps.store, ownerId, agentId))) {
        throw new ComputerdClientError(404, 'agent_not_found', `agent ${agentId} not found`);
      }
      return ensureComputer(deps.store, client, ownerId, agentId, getConfig().COMPUTER_RESOLUTION, signal());
    }),
  );

  app.post('/v1/computers/:id/pause', (c) =>
    action(c, async () => {
      await client.pause(signal());
      return deps.store.patch('computers', c.req.param('id'), { state: 'paused' });
    }),
  );

  app.post('/v1/computers/:id/resume', (c) =>
    action(c, async () => {
      await client.resume(signal());
      return deps.store.patch('computers', c.req.param('id'), { state: 'running' });
    }),
  );

  app.get('/v1/computers/:id/screens', (c) => action(c, async () => ({ items: await publicScreens(getOwnerId(c)) })));

  app.get('/v1/computers/:id/agents/:agentId/screen', (c) =>
    action(c, async () => {
      const screens = await publicScreens(getOwnerId(c));
      const screen = screens.find((item) => item.agentId === c.req.param('agentId'));
      if (!screen) throw new ComputerdClientError(404, 'no_screen', 'this agent has no screen yet');
      return screen;
    }),
  );

  app.post('/v1/computers/:id/screens', (c) =>
    action(c, async () => {
      const ownerId = getOwnerId(c);
      const requested = await readAgentId(c);
      if (requested.status !== 'agent') throw new ComputerdClientError(400, 'invalid_agent_id', 'agentId must be a non-empty string');
      if (!(await ownsAgent(deps.store, ownerId, requested.agentId))) {
        throw new ComputerdClientError(404, 'agent_not_found', `agent ${requested.agentId} not found`);
      }
      const screen = await client.ensureScreen(requested.agentId, signal());
      return remapScreen(screen, await computerIdFor(deps.store, ownerId), ownerId);
    }),
  );

  const byId = (c: Context, run: (agentId: string, screen: ScreenResponse) => Promise<unknown>): Promise<Response> =>
    action(c, async () => {
      const screen = await client.screenById(c.req.param('id') ?? '', signal());
      // A screen of an agent this owner cannot use answers exactly like an unknown one.
      if (!screen || !(await ownsAgent(deps.store, getOwnerId(c), screen.agentId))) {
        throw new ComputerdClientError(404, 'no_screen', 'unknown screen');
      }
      return run(screen.agentId, screen);
    });

  app.post('/v1/screens/:id/take-over', (c) =>
    byId(c, async (agentId) => {
      const ownerId = getOwnerId(c);
      const { changed, ...screen } = await client.takeOver(agentId, signal(), controlRequest(c, ownerId));
      // computerd says whether THIS call moved control: only a real change is news to the agent (a double click is not).
      if (changed) await announceControl(deps, ownerId, { surface: { kind: 'screen', screenId: screen.id }, agentId, epoch: screen.controlEpoch, phase: 'taken' }).catch(noteFailed);
      return remapScreen(screen, await computerIdFor(deps.store, ownerId), ownerId);
    }),
  );

  app.post('/v1/screens/:id/return-control', (c) =>
    byId(c, async (agentId) => {
      const ownerId = getOwnerId(c);
      const { changed, handBack, ...screen } = await client.returnControl(agentId, signal(), controlRequest(c, ownerId));
      if (changed) await announceControl(deps, ownerId, { surface: { kind: 'screen', screenId: screen.id }, agentId, epoch: screen.controlEpoch, phase: 'returned', ...(handBack ? { handBack } : {}) }).catch(noteFailed);
      // Handing the screen back is the answer to a pending take-over request: the waiting run resumes.
      await approveComputerRequests(deps, ownerId, agentId).catch(noteFailed);
      return remapScreen(screen, await computerIdFor(deps.store, ownerId), ownerId);
    }),
  );

  // The computer clipboard (M-CLIP): an image or files from the device onto the agent's computer, and what the computer
  // copied back. Only while the user holds the screen (the rule of the writable stream); a body over the upload limit is 413.
  app.post('/v1/screens/:id/clipboard', (c) =>
    byId(c, async (agentId, screen) => {
      if (screen.controller !== 'user') throw new ComputerdClientError(409, 'NOT_IN_CONTROL', 'take over the screen first');
      if (Number(c.req.header('content-length') ?? 0) > CLIPBOARD_BODY_BYTES) {
        throw new ComputerdClientError(413, 'too_large', `the clipboard item is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
      }
      const parsed = screenClipboardPasteSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) throw new ComputerdClientError(400, 'invalid_clipboard', 'the clipboard item does not match the contract');
      return client.pasteClipboard(agentId, parsed.data, signal());
    }),
  );

  app.get('/v1/screens/:id/clipboard', (c) =>
    byId(c, async (agentId, screen) => {
      if (screen.controller !== 'user') throw new ComputerdClientError(409, 'NOT_IN_CONTROL', 'take over the screen first');
      return client.copyClipboard(agentId, signal());
    }),
  );

  // Tap targets for the user's fingers: only while the user drives the screen or the agent asked them to.
  app.get('/v1/screens/:id/elements', (c) =>
    byId(c, async (agentId, screen) => {
      if (screen.controller !== 'user' && (await pendingComputerRequests(deps.store, agentId)).length === 0) {
        throw new ComputerdClientError(409, 'NOT_IN_CONTROL', 'take over the screen first');
      }
      return client.elements(agentId, signal());
    }),
  );

  app.get('/v1/screens/:id/screenshot', (c) => byId(c, (agentId) => client.screenshot({ agentId }, signal())));

  app.post('/v1/screens/:id/stream', (c) =>
    byId(c, async (agentId) => {
      const ownerId = getOwnerId(c);
      const screens = await publicScreens(ownerId);
      const screen = screens.find((item) => item.agentId === agentId);
      if (!screen) throw new ComputerdClientError(404, 'no_screen', 'unknown screen');
      const requested = await readControl(c);
      // Writable requires both the request and a screen the user actually controls.
      const control = requested && screen.controller === 'user';
      const expiresAt = Date.now() + getConfig().SCREEN_TICKET_TTL_MS;
      const ticket = signScreenTicket({ screenId: screen.id, ownerId, agentId, control, epoch: screen.controlEpoch, expiresAt }, getConfig().SCREEN_TICKET_SECRET);
      return {
        url: `${webSocketOrigin(c.req.url)}/v1/screens/${encodeURIComponent(screen.id)}/vnc?t=${encodeURIComponent(ticket)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        control,
      };
    }),
  );
}

/**
 * The requested agent from an optional JSON body. `absent` (no body, empty body, or no `agentId`
 * key) stays distinct from `invalid` (unparseable JSON, a non-object body, or a non-string/empty
 * agentId): the caller decides, and an invalid value must never fall through to a VM side effect.
 */
type AgentIdRequest = { status: 'absent' } | { status: 'agent'; agentId: string } | { status: 'invalid' };

async function readAgentId(c: Context): Promise<AgentIdRequest> {
  const raw = await c.req.text();
  if (raw.trim() === '') return { status: 'absent' };
  const body: unknown = parseJson(raw);
  if (!isRecord(body)) return { status: 'invalid' };
  const value: unknown = body['agentId'];
  if (value === undefined) return { status: 'absent' };
  if (typeof value === 'string' && value.length > 0) return { status: 'agent', agentId: value };
  return { status: 'invalid' };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only an agent the owner may mutate can be bound to the owner's machine. */
async function ownsAgent(store: Store, ownerId: string, agentId: string): Promise<boolean> {
  const agent = await store.get('agents', agentId);
  if (!agent) return false;
  return canMutateAgent(agent, ownerId);
}

/** \`control\` defaults to false so a watcher can never become writable by accident. */
async function readControl(c: Context): Promise<boolean> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null) return false;
  return (body as { control?: unknown }).control === true;
}

function webSocketOrigin(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
}
