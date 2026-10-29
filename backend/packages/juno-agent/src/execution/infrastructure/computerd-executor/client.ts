/** The runner's ComputerClient: wires the computerd HTTP endpoints to the injected contract. */

import type { BrowserInput, ComputerClient } from '../../../modules/tools/index.js';
import { meetInput, parseMeet, browserInput, fileWrite, isRecord, parseBrowser, parseCopy, parseEnvironment, parseFileRead, parseFileWrite, parseNavigate, parseProcessOutput, parseProcessSnapshot, parseProcessStop, parseProcessWrite, parseRecording, parseScreenshot, parseShell, point, processRead, processStart, processWrite, recordAudioInput, scroll, shell, jevMcpStart, jevMcpRead, jevMcpWrite } from './codec.js';
import { createRequester, type MacAccessResolver, type OwnerResolver } from './http.js';
import { ComputerError, type HomeComputer, type MacDesktopResult, homeContentSchema, homeExtractedTextSchema, homePutResultSchema, homeSnapshotSchema } from '../../../ports/computer/index.js';

const MAC_SCREEN_ACTIONS: ReadonlySet<string> = new Set([
  'mac/snapshot', 'mac/act', 'mac/verify',
  'browser/navigate', 'browser/action', 'audio', 'mac-apps',
]);
/** The coordinate actions the Mac no longer has: asking for one on the Mac fails here instead of falling through to the sandbox. */
const GONE_ON_MAC: ReadonlySet<string> = new Set(['screenshot', 'click', 'double-click', 'right-click', 'move', 'type', 'key', 'scroll']);

export interface ComputerdClientOptions {
  baseUrl: string;
  /** Bearer token computerd expects; agentd holds the same secret when proxying tickets. */
  token?: string;
  fetch: typeof fetch;
  /** Authenticated owner per agent, awaited before every request. */
  getOwnerId?: OwnerResolver;
  /** Whether the owner lets each agent use their Mac. */
  getMacAccess?: MacAccessResolver;
}

export function createComputerdClient(opts: ComputerdClientOptions): ComputerClient {
  const request = createRequester({
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.getOwnerId !== undefined ? { getOwnerId: opts.getOwnerId } : {}),
    ...(opts.getMacAccess !== undefined ? { getMacAccess: opts.getMacAccess } : {}),
  });
  const screen = (agentId: string, action: string, on?: 'sandbox' | 'mac'): { method: string; path: string; agentId: string; on?: 'mac' } => {
    if (on === 'mac' && GONE_ON_MAC.has(action)) throw new ComputerError('not_allowed', 'Screenshots and clicks do not work on the Mac any more: use computer.snapshot, computer.act and computer.verify.');
    return screenTarget(agentId, action, on);
  };
  const screenTarget = (agentId: string, action: string, on?: 'sandbox' | 'mac'): { method: string; path: string; agentId: string; on?: 'mac' } => ({
    method: 'POST',
    path: `/v1/screens/self/${action}`,
    agentId,
    // Forward a target only for capabilities the owner's Mac implements; absent stays the sandbox default.
    ...(on === 'mac' && (/^(shell|files|processes)\//.test(action) || MAC_SCREEN_ACTIONS.has(action)) ? { on: 'mac' as const } : {}),
  });

  const home: HomeComputer = {
    async snapshot(agentId, signal) {
      return parseHome(homeSnapshotSchema, await request.json({ method: 'POST', path: '/v1/home/snapshot', agentId, body: { agentId }, signal }));
    },
    async read(agentId, path, signal) {
      const body = await request.json({ method: 'POST', path: '/v1/home/read', agentId: homeAgent(agentId), body: { path }, signal });
      return isRecord(body) && body['missing'] === true ? null : parseHome(homeContentSchema, body);
    },
    async write(agentId, path, content, expectedHash, signal) {
      const body = await request.json({
        method: 'POST', path: '/v1/home/write', agentId: homeAgent(agentId), signal,
        body: { path, content, ...(expectedHash === undefined ? {} : { expectedHash }) },
      });
      return parseHome(homeContentSchema.pick({ hash: true }), body);
    },
    async putFile(agentId, path, bytes, signal) {
      const body = await request.json({
        method: 'POST', path: '/v1/home/put-file', agentId: homeAgent(agentId), signal,
        body: { path, contentBase64: Buffer.from(bytes).toString('base64') },
      });
      return parseHome(homePutResultSchema, body);
    },
    async extractText(agentId, path, format, signal) {
      return parseHome(homeExtractedTextSchema, await request.json({ method: 'POST', path: '/v1/home/extract-text', agentId: homeAgent(agentId), body: { path, format }, signal }));
    },
    async delete(agentId, path, expectedHash, signal) {
      await request.send({
        method: 'POST', path: '/v1/home/delete', agentId: homeAgent(agentId), signal,
        body: { path, ...(expectedHash === undefined ? {} : { expectedHash }) },
      });
    },
    async ensure(agentId, path, signal) {
      await request.send({ method: 'POST', path: '/v1/home/ensure', agentId: homeAgent(agentId), body: { path }, signal });
    },
  };

  return {
    home,
    async screenshot(agentId, signal, on) {
      return parseScreenshot(await request.json({ ...screen(agentId, 'screenshot', on), body: {}, signal }));
    },
    async click(agentId, input, signal, on) {
      await request.send({ ...screen(agentId, 'click', on), body: point(input), signal });
    },
    async doubleClick(agentId, input, signal, on) {
      await request.send({ ...screen(agentId, 'double-click', on), body: point(input), signal });
    },
    async rightClick(agentId, input, signal, on) {
      await request.send({ ...screen(agentId, 'right-click', on), body: point({ ...input, button: 'right' }), signal });
    },
    async move(agentId, input, signal, on) {
      await request.send({ ...screen(agentId, 'move', on), body: point(input), signal });
    },
    async type(agentId, text, signal, on) {
      await request.send({ ...screen(agentId, 'type', on), body: { text }, signal });
    },
    async pressKey(agentId, key, signal, on) {
      await request.send({ ...screen(agentId, 'key', on), body: { key }, signal });
    },
    async scroll(agentId, input, signal, on) {
      await request.send({ ...screen(agentId, 'scroll', on), body: scroll(input), signal });
    },
    async navigate(agentId, url, signal, on) {
      return parseNavigate(await request.json({ ...screen(agentId, 'browser/navigate', on), body: { url }, signal }), url);
    },
    async browser(agentId: string, input: BrowserInput, signal: AbortSignal, on) {
      return parseBrowser(await request.json({ ...screen(agentId, 'browser/action', on), body: browserInput(input), signal }));
    },
    async meet(agentId, input, signal) {
      return parseMeet(await request.json({ ...screen(agentId, 'browser/meet'), body: meetInput(input), signal }));
    },
    async recordAudio(agentId, input, signal, on) {
      return parseRecording(await request.json({ ...screen(agentId, 'audio', on), body: recordAudioInput(input), signal }));
    },
    async macDesktop(agentId, action, input, signal) {
      return parseMacDesktop(await request.json({ ...screen(agentId, `mac/${action}`, 'mac'), body: input, signal }));
    },
    async macApps(agentId, input, signal) {
      const body = await request.json({ ...screen(agentId, 'mac-apps', 'mac'), body: input, signal });
      if (!isRecord(body) || typeof body['text'] !== 'string') throw new ComputerError('failed', 'the Mac returned an unexpected answer');
      return body['text'];
    },
    async macStatus(agentId, signal) {
      const body = await request.json({ method: 'GET', path: '/v1/mac', agentId, signal });
      if (!isRecord(body) || typeof body['paired'] !== 'boolean' || typeof body['online'] !== 'boolean') throw new ComputerError('failed', 'computerd returned an unexpected Mac status');
      return { paired: body['paired'], online: body['online'] };
    },
    async runShell(agentId, input, signal, on) {
      return parseShell(await request.json({ ...screen(agentId, 'shell/run', on), body: shell(input), signal }));
    },
    async readFile(agentId, path, signal, on) {
      return parseFileRead(await request.json({ ...screen(agentId, 'files/read', on), body: { path }, signal }));
    },
    async writeFile(agentId, input, signal, on) {
      return parseFileWrite(await request.json({ ...screen(agentId, 'files/write', on), body: fileWrite(input), signal }), input.path);
    },
    async environment(agentId, signal, on) {
      return parseEnvironment(
        await request.json({ method: 'GET', path: '/v1/screens/self/environment', agentId, signal, ...(on === 'mac' ? { on } : {}) }),
      );
    },
    async copy(agentId, input, signal) {
      // The bytes move inside computerd, which holds both computers; the owner's Mac side needs the agent's Mac access.
      return parseCopy(await request.json({ ...screen(agentId, 'computer/copy'), ...(input.from === 'mac' || input.to === 'mac' ? { on: 'mac' as const } : {}), body: { ...input }, signal }));
    },
    async ensureScreen(agentId, signal) {
      await request.send({ ...screen(agentId, 'ensure'), body: {}, signal });
    },
    async startProcess(agentId, input, signal, on) {
      return parseProcessSnapshot(await request.json({ ...screen(agentId, 'processes/start', on), body: processStart(input), signal }));
    },
    async readProcess(agentId, input, signal, on) {
      return parseProcessOutput(await request.json({ ...screen(agentId, 'processes/read', on), body: processRead(input), signal }));
    },
    async writeProcess(agentId, input, signal, on) {
      return parseProcessWrite(await request.json({ ...screen(agentId, 'processes/write', on), body: processWrite(input), signal }), input.handle);
    },
    async installPackages(agentId, input, signal) {
      const body: unknown = await request.json({ ...screen(agentId, 'install-packages'), body: { packages: input.packages, reason: input.reason }, signal });
      const output = isRecord(body) ? body['output'] : undefined;
      if (typeof output !== 'string') throw new ComputerError('failed', 'computerd returned an invalid install result');
      return { output };
    },
    async spacePorts(agentId, signal) {
      const body: unknown = await request.json({ ...screen(agentId, 'spaces/ports'), body: {}, signal });
      const ports = isRecord(body) ? body['ports'] : undefined;
      if (!Array.isArray(ports) || !ports.every((port) => Number.isInteger(port))) throw new ComputerError('failed', 'computerd returned an invalid port list');
      return ports.map(Number);
    },
    async registerSpace(agentId, input, signal) {
      const body: unknown = await request.json({ ...screen(agentId, 'spaces/register'), body: { spaceId: input.spaceId, port: input.port }, signal });
      const computerId = isRecord(body) ? body['computerId'] : undefined;
      if (typeof computerId !== 'string' || computerId.length === 0) throw new ComputerError('failed', 'computerd returned an invalid space registration');
      return { computerId };
    },
    async stopProcess(agentId, input, signal, on) {
      return parseProcessStop(await request.json({ ...screen(agentId, 'processes/stop', on), body: { handle: input.handle }, signal }), input.handle);
    },
    async startJevMcp(agentId, signal, on) {
      return parseProcessSnapshot(await request.json({ ...screen(agentId, 'jevmcp/start', on), body: jevMcpStart(), signal }));
    },
    async readJevMcp(agentId, input, signal, on) {
      return parseProcessOutput(await request.json({ ...screen(agentId, 'jevmcp/read', on), body: jevMcpRead(input), signal }));
    },
    async writeJevMcp(agentId, input, signal, on) {
      return parseProcessWrite(await request.json({ ...screen(agentId, 'jevmcp/write', on), body: jevMcpWrite(input), signal }), input.handle);
    },
    async stopJevMcp(agentId, input, signal, on) {
      return parseProcessStop(await request.json({ ...screen(agentId, 'jevmcp/stop', on), body: { handle: input.handle }, signal }), input.handle);
    },
  };
}

function parseMacDesktop(body: unknown): MacDesktopResult {
  const image = isRecord(body) && isRecord(body['image']) ? body['image'] : undefined;
  if (!isRecord(body) || typeof body['ok'] !== 'boolean' || typeof body['text'] !== 'string'
    || (image !== undefined && (typeof image['mimeType'] !== 'string' || typeof image['data'] !== 'string'))) {
    throw new ComputerError('failed', 'the Mac returned an unexpected answer');
  }
  return {
    ok: body['ok'],
    text: body['text'],
    ...(body['needsForeground'] === true ? { needsForeground: true } : {}),
    ...(image === undefined ? {} : { image: { mimeType: String(image['mimeType']), data: String(image['data']) } }),
  };
}

/** The agent id the owner is resolved from; the sync always has one. */
function homeAgent(agentId: string | undefined): string {
  if (agentId === undefined) throw new ComputerError('not_allowed', 'a home call from the runner needs an agent id');
  return agentId;
}

function parseHome<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ComputerError('failed', 'computerd returned an invalid home response');
  return parsed.data;
}
