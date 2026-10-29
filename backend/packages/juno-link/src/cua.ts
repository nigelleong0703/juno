/**
 * The Mac's desktop backend: cua-driver (BACKEND §7.12). The desktop app starts `cua-driver serve --embedded --socket <path>`
 * and hands the daemon a `CuaClient` for that socket; the daemon maps the three agent actions (`snapshot`, `act`, `verify`)
 * onto cua-driver's own tools. No osascript and no global events here: cua-driver delivers input to the app's window in the
 * background, and anything that needs the app in front is a separate, owner-approved retry (`foreground`).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopRequest, MacActInput, MacDesktopResult, MacSnapshotInput, MacVerifyInput } from './protocol.js';

export interface CuaResponse {
  /** The tool's JSON answer (a refusal is a JSON answer too, with `isError`). */
  json: unknown;
  /** The PNG of the call, when it produced one. */
  image?: { mimeType: string; data: string };
  isError: boolean;
}

/** One cua-driver tool call. The host may inject its own (the SDK); `createCuaCliClient` is the default over the socket. */
export interface CuaClient {
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal, options?: { image?: boolean }): Promise<CuaResponse>;
}

const CALL_TIMEOUT_MS = 90_000;

/** `cua-driver call --socket <path> <tool> '<json>'`: one short process per call, killed with the call's signal (Stop). */
export function createCuaCliClient(options: { socketPath: string; binaryPath?: string }): CuaClient {
  return {
    async call(tool, args, signal, callOptions) {
      const dir = callOptions?.image === true ? await mkdtemp(join(tmpdir(), 'juno-cua-')) : undefined;
      const imagePath = dir === undefined ? undefined : join(dir, 'shot.png');
      try {
        const argv = ['call', '--socket', options.socketPath, ...(imagePath === undefined ? [] : ['--screenshot-out-file', imagePath]), tool, JSON.stringify(args)];
        const { code, stdout, stderr } = await run(options.binaryPath ?? 'cua-driver', argv, signal);
        let json: unknown;
        try {
          json = JSON.parse(stdout);
        } catch {
          if (code !== 0) throw new Error(`cua-driver ${tool} failed: ${(stderr || stdout).trim().slice(0, 400)}`);
          json = { text: stdout.trim() };
        }
        const image = imagePath === undefined ? undefined : await readFile(imagePath).then((bytes) => ({ mimeType: 'image/png', data: bytes.toString('base64') }), () => undefined);
        return { json, ...(image === undefined ? {} : { image }), isError: code !== 0 };
      } finally {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function run(file: string, argv: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// --- The three actions -------------------------------------------------------------------------------------------

const MAX_TEXT = 12_000;
/** The only tools a step may name: cua-driver's action tools, no reads and nothing that retargets or launches. */
const STEP_TOOLS: ReadonlySet<string> = new Set(['click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag']);
/** Keys of a step that would aim it at another app/window or pick the delivery: the app and the delivery are decided by the owner's approval, not by the agent. */
const FORBIDDEN_STEP_KEYS = ['app', 'pid', 'window_id', 'delivery_mode', 'foreground_fallback', 'session'];

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;

class DesktopRefusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const clip = (text: string): string => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n... (cut at ${MAX_TEXT} characters)`);

interface Target {
  pid: number;
  windowId: number;
  appName: string;
  title: string;
}

/** A short public label for cua-driver's session (cursor colour and snapshot cache per agent). */
const sessionOf = (agentId: string): string => agentId.slice(0, 32);

/**
 * The one window the agent means: the app by exact name or bundle id (never a substring, so an approval for "Notes" cannot
 * reach "Notion"), on screen and frontmost first. Two different apps matching is an error the model can fix.
 */
async function resolveTarget(client: CuaClient, app: string, session: string, signal: AbortSignal): Promise<Target> {
  const wanted = app.trim();
  if (wanted === '') throw new DesktopRefusal('app is empty: name the app, e.g. "Notes" or "com.apple.Notes"');
  const listed = await client.call('list_windows', { app: wanted, session }, signal);
  const windows = field(listed.json, 'windows');
  const matching = (Array.isArray(windows) ? windows : []).filter(isRecord).filter((window) => {
    if (typeof window['pid'] !== 'number' || typeof window['window_id'] !== 'number') return false;
    // For a bundle id cua-driver already filtered by equality.
    return BUNDLE_ID.test(wanted) || String(window['app_name'] ?? '').trim().toLowerCase() === wanted.toLowerCase();
  });
  if (matching.length === 0) throw new DesktopRefusal(`${wanted} has no open window on this Mac. Ask the user to open it (nothing was done).`);
  const apps = new Set(matching.map((window) => `${String(window['app_name'])}#${String(window['pid'])}`));
  if (new Set(matching.map((window) => window['pid'])).size > 1) {
    throw new DesktopRefusal(`"${wanted}" matches more than one app (${[...apps].map((entry) => entry.split('#')[0]).join(', ')}); use the exact name or the bundle id.`);
  }
  const best = [...matching].sort((a, b) => rank(b) - rank(a))[0] ?? matching[0];
  return { pid: Number(best?.['pid']), windowId: Number(best?.['window_id']), appName: String(best?.['app_name'] ?? wanted), title: String(best?.['title'] ?? '') };
}

const rank = (window: Record<string, unknown>): number =>
  (window['is_on_screen'] === true ? 1_000_000 : 0) + (window['on_current_space'] === true ? 500_000 : 0) + (typeof window['z_index'] === 'number' ? window['z_index'] : 0);

function header(target: Target): string {
  return `${target.appName}${target.title === '' ? '' : ` — "${target.title}"`} (window ${target.windowId})`;
}

/** The tree of a `get_window_state` answer as text, with the flags the model has to read (degraded, truncated). */
function treeText(target: Target, json: unknown): { text: string; empty: boolean } {
  const rows = field(json, 'tree_markdown');
  const count = field(json, 'element_count');
  const degraded = field(json, 'degraded_reason') ?? (field(json, 'degraded') === true ? 'degraded' : undefined);
  const empty = typeof rows !== 'string' || rows.trim() === '' || count === 0 || degraded !== undefined;
  const lines = [`${header(target)}${typeof field(json, 'snapshot_id') === 'string' ? ` · snapshot ${String(field(json, 'snapshot_id'))}` : ''}`];
  if (degraded !== undefined) lines.push(`No usable elements (${String(degraded)}): act by x,y pixels of the screenshot, or re-snapshot.`);
  lines.push(typeof rows === 'string' ? rows : clip(JSON.stringify(json)));
  return { text: clip(lines.join('\n')), empty };
}

async function snapshot(client: CuaClient, agentId: string, input: MacSnapshotInput, signal: AbortSignal): Promise<MacDesktopResult> {
  const session = sessionOf(agentId);
  const target = await resolveTarget(client, input.app, session, signal);
  const base = { pid: target.pid, window_id: target.windowId, session, ...(input.query === undefined || input.query === '' ? {} : { query: input.query }) };
  const read = await client.call('get_window_state', { ...base, include_screenshot: false }, signal);
  if (read.isError) return { ok: false, text: clip(`${header(target)}: ${JSON.stringify(read.json)}`) };
  const tree = treeText(target, read.json);
  // A picture only when asked for, or when the tree gave nothing to act on.
  if (input.screenshot !== true && !tree.empty) return { ok: true, text: tree.text };
  const shot = await client.call('get_window_state', { pid: target.pid, window_id: target.windowId, session, include_accessibility_tree: false, max_dimension: 900 }, signal, { image: true });
  return { ok: true, text: tree.text, ...(shot.image === undefined ? {} : { image: shot.image }) };
}

function checkSteps(steps: MacActInput['steps']): void {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 32) throw new DesktopRefusal('act needs 1 to 32 steps');
  steps.forEach((step, index) => {
    if (!isRecord(step) || typeof step.tool !== 'string' || !STEP_TOOLS.has(step.tool)) {
      throw new DesktopRefusal(`step ${index + 1}: tool must be one of ${[...STEP_TOOLS].join(', ')}`);
    }
    for (const key of FORBIDDEN_STEP_KEYS) {
      if (step.args !== undefined && key in step.args) throw new DesktopRefusal(`step ${index + 1}: "${key}" is not allowed in a step (the app is the call's app)`);
    }
  });
}

async function act(client: CuaClient, agentId: string, input: MacActInput, signal: AbortSignal): Promise<MacDesktopResult> {
  checkSteps(input.steps);
  const session = sessionOf(agentId);
  const target = await resolveTarget(client, input.app, session, signal);
  const response = await client.call('run_steps', {
    pid: target.pid,
    window_id: target.windowId,
    session,
    steps: input.steps,
    observe: {},
    ...(input.foreground === true ? { delivery_mode: 'foreground' } : {}),
  }, signal);
  const text = JSON.stringify(response.json);
  // A real run_steps answer always carries `failed_step` (null on success), so only a set index or ok:false is a failure.
  const failedStep = field(response.json, 'failed_step');
  const failed = response.isError || (failedStep !== undefined && failedStep !== null) || field(response.json, 'ok') === false;
  const needsForeground = input.foreground !== true && text.includes('background_unavailable');
  return {
    ok: !failed,
    text: clip(`${header(target)}\n${text}`),
    ...(needsForeground ? { needsForeground: true } : {}),
  };
}

async function verify(client: CuaClient, agentId: string, input: MacVerifyInput, signal: AbortSignal): Promise<MacDesktopResult> {
  if (!Array.isArray(input.expect) || input.expect.length === 0 || input.expect.length > 8) throw new DesktopRefusal('verify needs 1 to 8 expect predicates');
  const session = sessionOf(agentId);
  const target = await resolveTarget(client, input.app, session, signal);
  const response = await client.call('verify_state', { pid: target.pid, window_id: target.windowId, session, expect: input.expect }, signal);
  const text = JSON.stringify(response.json);
  // "unknown" is not success: only an explicit satisfied answer counts.
  const satisfied = !response.isError && (field(response.json, 'satisfied') === true || ['status', 'result', 'outcome'].some((key) => field(response.json, key) === 'satisfied'));
  return { ok: satisfied, text: clip(`${header(target)}\n${text}`) };
}

const asObject = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** The handler for `snapshot`, `act` and `verify`. A refusal is a normal answer (`ok: false`) the model can read, not a transport error. */
export async function runCuaDesktop(client: CuaClient, request: DesktopRequest, signal: AbortSignal): Promise<MacDesktopResult> {
  const input = asObject(request.input);
  const app = typeof input['app'] === 'string' ? input['app'] : '';
  try {
    switch (request.action) {
      case 'snapshot':
        return await snapshot(client, request.agentId, { app, ...(typeof input['query'] === 'string' ? { query: input['query'] } : {}), ...(input['screenshot'] === true ? { screenshot: true } : {}) }, signal);
      case 'act':
        return await act(client, request.agentId, { app, steps: input['steps'] as MacActInput['steps'], ...(input['foreground'] === true ? { foreground: true } : {}) }, signal);
      case 'verify':
        return await verify(client, request.agentId, { app, expect: input['expect'] as MacVerifyInput['expect'] }, signal);
      default:
        throw new DesktopRefusal(`${request.action} is not a cua-driver action`);
    }
  } catch (error) {
    if (error instanceof DesktopRefusal) return { ok: false, text: error.message };
    throw error;
  }
}

/** The actions the daemon serves itself when it has a `CuaClient`. */
export const CUA_ACTIONS: ReadonlySet<string> = new Set(['snapshot', 'act', 'verify']);
