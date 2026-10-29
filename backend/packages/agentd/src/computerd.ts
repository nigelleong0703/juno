/**
 * agentd's client for computerd's internal API. agentd only ever calls computerd, never E2B, so all
 * sandbox knowledge stays in one service. Errors are translated to a stable \`{code,message}\` shape
 * for the public API.
 */
import { z } from 'zod';
import { controlStateSchema, handBackSchema, type ControlState, type HandBack, type ScreenResponse, type SurfaceRef } from '@agent-desktop/contracts';
import { computerRuntimeSchema, macPairingSchema, macStatusSchema, screenClipboardPasteResultSchema, screenClipboardSchema, screenElementsSchema, type ComputerRuntime, type MacPairing, type MacStatus, type ScreenClipboard, type ScreenClipboardPaste, type ScreenClipboardPasteResult, type ScreenElements } from '@agent-desktop/public-contracts';
import { browserResultSchema, homeContentSchema, homeExtractedTextSchema, homePutResultSchema, homeSnapshotSchema, meetResultSchema, type BrowserInput, type BrowserResult, type MeetInput, type MeetResult, type HomeComputer, type ProcessStopResult } from 'juno-agent/computer';
import { parseProcessStop } from 'juno-agent/execution/infrastructure/computerd-executor/codec';

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

export interface Screenshot {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
  displayNo?: number;
}

/** A screen as the public API exposes it: the sandbox id is remapped, the owner id stays. */
export type PublicScreen = Omit<ScreenResponse, 'computerId'> & { computerId: string };

export type { HandBack };

/** Who takes or hands back, for the audit trail; `expectEpoch` (the `controlEpoch` the client saw) makes a stale tap a no-op. */
export interface ControlRequest {
  actorId?: string;
  via?: string;
  expectEpoch?: number;
}

export interface ScreenshotInput {
  agentId: string;
}

export interface ComputerdClient {
  computer(signal: AbortSignal): Promise<ComputerView>;
  screens(signal: AbortSignal): Promise<ScreenResponse[]>;
  screenById(id: string, signal: AbortSignal): Promise<ScreenResponse | null>;
  ensureScreen(agentId: string, signal: AbortSignal): Promise<ScreenResponse>;
  /** `changed` is true only for the call that moved control (computerd decides; agentd never reads the screen first). */
  takeOver(agentId: string, signal: AbortSignal, request?: ControlRequest): Promise<ScreenResponse & { changed: boolean }>;
  returnControl(agentId: string, signal: AbortSignal, request?: ControlRequest): Promise<ScreenResponse & { changed: boolean; handBack?: HandBack }>;
  /** The control row of a surface (who holds it, the newest hand-back), or null for an unknown screen. */
  controlState(surface: SurfaceRef, signal: AbortSignal): Promise<ControlState | null>;
  screenshot(input: ScreenshotInput, signal: AbortSignal): Promise<Screenshot>;
  /** One typed DOM action on the agent's Chromium (the secure-input fill); refused while the user controls the screen. */
  browser(agentId: string, input: BrowserInput, signal: AbortSignal): Promise<BrowserResult>;
  /** One Google Meet action (join, state, chat, leave) through the sandbox's agent-meet helper; refused while the user controls the screen. */
  meet?(agentId: string, input: MeetInput, signal: AbortSignal): Promise<MeetResult>;
  /** Tap targets of the tab on the agent's screen, whoever controls it. */
  elements(agentId: string, signal: AbortSignal): Promise<ScreenElements>;
  /** The device's image or files onto the agent's computer (M-CLIP); refused unless the user controls the screen. */
  pasteClipboard(agentId: string, input: ScreenClipboardPaste, signal: AbortSignal): Promise<ScreenClipboardPasteResult>;
  /** What the computer's clipboard holds after the user's copy (M-CLIP); refused unless the user controls the screen. */
  copyClipboard(agentId: string, signal: AbortSignal): Promise<ScreenClipboard>;
  /** Stop one background process on the agent's computer (the user stopping a task). */
  stopProcess(agentId: string, handle: string, signal: AbortSignal, target?: 'mac'): Promise<ProcessStopResult>;
  /** Where the sandbox runs here and whether its image is ready. */
  runtime(signal: AbortSignal): Promise<ComputerRuntime>;
  /** The owner's Mac as a computer (My Mac): status, pairing (the token is returned once) and revoke. */
  macStatus(signal: AbortSignal): Promise<MacStatus>;
  macPair(name: string | undefined, signal: AbortSignal): Promise<MacPairing>;
  macRevoke(signal: AbortSignal): Promise<MacStatus>;
  /** Stop all agent access to the Mac (any client may); there is no remote resume. */
  macStop(request: ControlRequest, signal: AbortSignal): Promise<MacStatus>;
  pause(signal: AbortSignal): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  /** Whether the owner's computer runs, is paused or does not exist. A passive probe: it never resumes, renews or starts anything. */
  computerState(signal: AbortSignal): Promise<'running' | 'paused' | 'none'>;
  /** Account deletion (BACKEND §5.2c): remove the owner's computers, their durable storage, state files and paired Mac. Idempotent. */
  eraseOwner?(signal: AbortSignal): Promise<OwnerErasure>;
  /** The owner's `/juno` files (BACKEND §5.2); the owner is the request's, so the agent id is not needed. */
  home?: HomeComputer;
}

/** What computerd removed for a deleted account (volumes / object folders / schemas in words, and its own state files). */
export interface OwnerErasure {
  computers: number;
  removed: string[];
  files: string[];
  macRevoked: boolean;
}

export class ComputerdClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ComputerdClientError';
    this.status = status;
    this.code = code;
  }
}

export interface ComputerdClientOptions {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  /** Authenticated owner for this request (server-resolved, never an incoming user header). */
  getOwnerId?: () => string;
}

export function createComputerdClient(opts: ComputerdClientOptions): ComputerdClient {
  const ownerHeader = (): Record<string, string> => {
    const ownerId = opts.getOwnerId?.();
    if (typeof ownerId === 'string' && ownerId.length > 0) return { 'x-owner-id': ownerId };
    return {};
  };
  const call = async (
    path: string,
    init: { method: string; agentId?: string; body?: unknown; signal: AbortSignal; computer?: 'mac'; headers?: Record<string, string> },
  ): Promise<unknown> => {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (init.computer) headers['x-computer'] = init.computer;
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    if (init.agentId) headers['x-agent-id'] = init.agentId;
    Object.assign(headers, ownerHeader());
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await opts.fetch(new URL(path, opts.baseUrl).toString(), {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init.signal,
    });
    if (!response.ok) throw await toError(response, path);
    return readJson(response);
  };

  const homeCall = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => call(path, { method: 'POST', body, signal });
  const parseHome = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid home response');
    return parsed.data;
  };
  const home: HomeComputer = {
    async snapshot(agentId, signal) {
      return parseHome(homeSnapshotSchema, await homeCall('/v1/home/snapshot', { agentId }, signal));
    },
    async read(_agentId, path, signal) {
      const body = await homeCall('/v1/home/read', { path }, signal);
      return isRecord(body) && body['missing'] === true ? null : parseHome(homeContentSchema, body);
    },
    async write(_agentId, path, content, expectedHash, signal) {
      return parseHome(homeContentSchema.pick({ hash: true }), await homeCall('/v1/home/write', { path, content, ...(expectedHash === undefined ? {} : { expectedHash }) }, signal));
    },
    async putFile(_agentId, path, bytes, signal) {
      return parseHome(homePutResultSchema, await homeCall('/v1/home/put-file', { path, contentBase64: Buffer.from(bytes).toString('base64') }, signal));
    },
    async extractText(_agentId, path, format, signal) {
      return parseHome(homeExtractedTextSchema, await homeCall('/v1/home/extract-text', { path, format }, signal));
    },
    async delete(_agentId, path, expectedHash, signal) {
      await homeCall('/v1/home/delete', { path, ...(expectedHash === undefined ? {} : { expectedHash }) }, signal);
    },
    async ensure(_agentId, path, signal) {
      await homeCall('/v1/home/ensure', { path }, signal);
    },
  };

  return {
    home,
    async computer(signal) {
      const body = await call('/v1/computer', { method: 'GET', signal });
      return parseComputer(body);
    },
    async screens(signal) {
      const body = await call('/v1/screens', { method: 'GET', signal });
      return isRecord(body) && Array.isArray(body['items']) ? body['items'].map(parseScreen) : [];
    },
    async screenById(id, signal) {
      const response = await opts.fetch(new URL(`/v1/screens/${encodeURIComponent(id)}`, opts.baseUrl).toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...ownerHeader(),
        },
        signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw await toError(response, '/v1/screens/:id');
      return parseScreen(await readJson(response));
    },
    async ensureScreen(agentId, signal) {
      return parseScreen(await call('/v1/screens/self/ensure', { method: 'POST', agentId, signal }));
    },
    async takeOver(agentId, signal, request) {
      const body = await call('/v1/screens/self/take-over', { method: 'POST', agentId, signal, headers: controlHeaders(request) });
      return { ...parseScreen(body), changed: isRecord(body) && body['changed'] === true };
    },
    async returnControl(agentId, signal, request) {
      const body = await call('/v1/screens/self/return-control', { method: 'POST', agentId, signal, headers: controlHeaders(request) });
      const parsed = isRecord(body) ? handBackSchema.safeParse(body['handBack']) : undefined;
      return { ...parseScreen(body), changed: isRecord(body) && body['changed'] === true, ...(parsed?.success ? { handBack: parsed.data } : {}) };
    },
    async controlState(surface, signal) {
      const id = surface.kind === 'screen' ? surface.screenId : surface.macId;
      const response = await opts.fetch(new URL(`/v1/controls/${surface.kind}/${encodeURIComponent(id)}`, opts.baseUrl).toString(), {
        method: 'GET',
        headers: { accept: 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...ownerHeader() },
        signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw await toError(response, '/v1/controls/:kind/:id');
      const parsed = controlStateSchema.safeParse(await readJson(response));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid control state');
      return parsed.data;
    },
    async screenshot(input, signal) {
      const body = await call('/v1/screens/self/screenshot', { method: 'POST', agentId: input.agentId, body: {}, signal });
      return parseScreenshot(body);
    },
    async browser(agentId, input, signal) {
      const parsed = browserResultSchema.safeParse(await call('/v1/screens/self/browser/action', { method: 'POST', agentId, body: input, signal }));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid browser result');
      return parsed.data;
    },
    async meet(agentId, input, signal) {
      const parsed = meetResultSchema.safeParse(await call('/v1/screens/self/browser/meet', { method: 'POST', agentId, body: input, signal }));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid meet result');
      return parsed.data;
    },
    async elements(agentId, signal) {
      const parsed = screenElementsSchema.safeParse(await call('/v1/screens/self/elements', { method: 'GET', agentId, signal }));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned invalid screen elements');
      return parsed.data;
    },
    async pasteClipboard(agentId, input, signal) {
      const parsed = screenClipboardPasteResultSchema.safeParse(await call('/v1/screens/self/clipboard', { method: 'POST', agentId, body: input, signal }));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid clipboard result');
      return parsed.data;
    },
    async copyClipboard(agentId, signal) {
      const parsed = screenClipboardSchema.safeParse(await call('/v1/screens/self/clipboard', { method: 'GET', agentId, signal }));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid clipboard result');
      return parsed.data;
    },
    async stopProcess(agentId, handle, signal, target) {
      return parseProcessStop(await call('/v1/screens/self/processes/stop', { method: 'POST', agentId, body: { handle }, signal, ...(target ? { computer: target } : {}) }), handle);
    },
    async runtime(signal) {
      return parseMac(computerRuntimeSchema, await call('/v1/runtime', { method: 'GET', signal }));
    },
    async macStatus(signal) {
      return parseMac(macStatusSchema, await call('/v1/mac', { method: 'GET', signal }));
    },
    async macPair(name, signal) {
      return parseMac(macPairingSchema, await call('/v1/mac/pair', { method: 'POST', body: name === undefined ? {} : { name }, signal }));
    },
    async macRevoke(signal) {
      return parseMac(macStatusSchema, await call('/v1/mac', { method: 'DELETE', signal }));
    },
    async macStop(request, signal) {
      return parseMac(macStatusSchema, await call('/v1/mac/stop', { method: 'POST', signal, headers: controlHeaders(request) }));
    },
    async eraseOwner(signal) {
      const parsed = ownerErasureSchema.safeParse(await call('/v1/owner', { method: 'DELETE', signal }));
      if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid erasure report');
      return parsed.data;
    },
    async pause(signal) {
      await call('/v1/computer/pause', { method: 'POST', body: {}, signal });
    },
    async resume(signal) {
      await call('/v1/computer/resume', { method: 'POST', body: {}, signal });
    },
    async computerState(signal) {
      // The Spaces status route with no apps: it answers the computer's state and never resumes it (computerd routes-spaces.ts).
      const answer = await call('/v1/spaces/status', { method: 'POST', body: { spaces: [] }, signal });
      const state = isRecord(answer) ? answer['computer'] : undefined;
      return state === 'running' || state === 'paused' ? state : 'none';
    },
  };
}

const ownerErasureSchema = z.object({ computers: z.number(), removed: z.array(z.string()), files: z.array(z.string()), macRevoked: z.boolean() });

function parseMac<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid Mac response');
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

async function toError(response: Response, path: string): Promise<ComputerdClientError> {
  const body = await readJson(response);
  const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : 'failed';
  const message = isRecord(body) && typeof body['message'] === 'string' ? body['message'] : `computerd ${response.status} for ${path}`;
  return new ComputerdClientError(response.status, code, message);
}

function parseScreen(value: unknown): ScreenResponse {
  if (!isRecord(value)) throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid screen');
  const stringField = (key: string): string => {
    const field = value[key];
    if (typeof field !== 'string') throw new ComputerdClientError(500, 'failed', `computerd screen missing ${key}`);
    return field;
  };
  const displayNo = value['displayNo'];
  if (typeof displayNo !== 'number') throw new ComputerdClientError(500, 'failed', 'computerd screen missing displayNo');
  const controller = value['controller'];
  if (controller !== 'agent' && controller !== 'user') {
    throw new ComputerdClientError(500, 'failed', 'computerd screen has an invalid controller');
  }
  const controlEpoch = value['controlEpoch'];
  if (typeof controlEpoch !== 'number') throw new ComputerdClientError(500, 'failed', 'computerd screen missing controlEpoch');
  const state = value['state'];
  if (state !== 'starting' && state !== 'live' && state !== 'asleep' && state !== 'error' && state !== 'stopped') {
    throw new ComputerdClientError(500, 'failed', 'computerd screen has an invalid state');
  }
  return {
    id: stringField('id'),
    ownerId: stringField('ownerId'),
    computerId: stringField('computerId'),
    agentId: stringField('agentId'),
    displayNo,
    state,
    controller,
    controlEpoch,
    ...(typeof value['controllerSince'] === 'string' ? { controllerSince: value['controllerSince'] } : {}),
    title: stringField('title'),
    resolution: stringField('resolution'),
    lastUsedAt: stringField('lastUsedAt'),
    lastVncPort: typeof value['lastVncPort'] === 'number' ? value['lastVncPort'] : 5900,
    lastWebPort: typeof value['lastWebPort'] === 'number' ? value['lastWebPort'] : 6080,
  };
}

/** Who is taking or handing back, as computerd's `x-actor-*` / `x-expect-epoch` headers. */
function controlHeaders(request: ControlRequest | undefined): Record<string, string> {
  return {
    ...(request?.actorId ? { 'x-actor-id': request.actorId } : {}),
    ...(request?.via ? { 'x-actor-via': request.via } : {}),
    ...(request?.expectEpoch === undefined ? {} : { 'x-expect-epoch': String(request.expectEpoch) }),
  };
}

function parseScreenshot(value: unknown): Screenshot {
  if (!isRecord(value) || typeof value['data'] !== 'string') {
    throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid screenshot');
  }
  return {
    data: value['data'],
    mimeType: typeof value['mimeType'] === 'string' ? value['mimeType'] : 'image/png',
    ...(typeof value['width'] === 'number' ? { width: value['width'] } : {}),
    ...(typeof value['height'] === 'number' ? { height: value['height'] } : {}),
    ...(typeof value['displayNo'] === 'number' ? { displayNo: value['displayNo'] } : {}),
  };
}

function parseComputer(value: unknown): ComputerView {
  if (!isRecord(value) || typeof value['sandboxId'] !== 'string') {
    throw new ComputerdClientError(500, 'failed', 'computerd returned an invalid computer');
  }
  const screens = Array.isArray(value['screens']) ? value['screens'].map(parseScreen) : [];
  const metrics = value['metrics'];
  return {
    sandboxId: value['sandboxId'],
    template: typeof value['template'] === 'string' ? value['template'] : 'desktop-debian',
    screens,
    metrics: isRecord(metrics) ? parseMetrics(metrics) : null,
  };
}

function parseMetrics(value: Record<string, unknown>): ComputerView['metrics'] {
  const num = (key: string): number => {
    const field = value[key];
    return typeof field === 'number' ? field : 0;
  };
  return {
    memUsedMb: num('memUsedMb'),
    memTotalMb: num('memTotalMb'),
    vcpu: num('vcpu'),
    cpuPercent: num('cpuPercent'),
    diskUsedGb: num('diskUsedGb'),
    diskTotalGb: num('diskTotalGb'),
  };
}
