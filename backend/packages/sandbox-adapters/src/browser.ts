/**
 * Typed browser actions for one agent display. The model never touches CDP directly: the
 * sandbox-local helper `/usr/local/bin/agent-browser` owns the CDP session and prints one JSON
 * document per request on stdout. The request/response schemas belong to the agent's computer
 * port (`juno-agent/computer`); this module builds the shell command that invokes the helper and
 * parses its output strictly against them.
 *
 * Helper contract (implemented by the image worker): argv
 * `--port <cdp> --request '<BrowserInput json>'`. Stdout is a single JSON object
 * `{ ok: true, ...result }` where the result echoes `action` plus its per-action fields. A
 * failure is a non-zero exit or `{ ok: false, error: "<reason>" }`; both surface as a truthful
 * `failed` error, never an invented page.
 */
import {
  browserResultSchema,
  type BrowserInput,
  type BrowserResult,
} from 'juno-agent/computer';
import { BrowserDownError, failed } from './errors.js';
import { screenPorts } from './ports.js';
import { rootDir, shq } from './screen-boot.js';
import { modelToScreenShell } from './model-screen.js';

// One schema for the typed browser actions: the agent's computer port owns it, this adapter only
// builds the helper command and parses its output against it.
export { browserInputSchema, browserResultSchema } from 'juno-agent/computer';
export type { BrowserInput, BrowserNode, BrowserResult } from 'juno-agent/computer';

export const BROWSER_HELPER = '/usr/local/bin/agent-browser';
/**
 * The helper runs as ROOT (BACKEND 8.7), never as the agent's user: it holds the sandbox's secure-input private key
 * and the values of secure fills, and it is the only process allowed to reach the browser's debugging port
 * (`isolation.ts`). Its ref/watch state therefore lives in a root-only tmpfs directory, one file set per CDP port.
 */
const HELPER = `AGENT_BROWSER_STATE=/run/juno/browser ${BROWSER_HELPER}`;
/** Upper bound for one helper call; the helper itself must finish well inside this. */
export const BROWSER_TIMEOUT_MS = 15_000;

/**
 * The exact program for one helper call: the display's CDP port plus the single-quoted request. A `fill_secret`
 * request carries only ciphertext sealed to the sandbox's own key, so nothing secret is in the program text.
 */
export function browserCommand(displayNo: number, input: BrowserInput): string {
  const port = screenPorts(displayNo).cdp;
  if (input.action === 'point' && input.x !== undefined && input.y !== undefined) {
    // Model coordinates (the screenshot's pixels) become framebuffer pixels in the sandbox, with the same
    // live-display scale as computer.click (model-screen.ts), so the check looks where the click lands. The helper
    // runs as root, so xdotool takes the display's cookie from the root-only record the screen boot wrote.
    const request = `"$(printf '{"action":"point","x":%s,"y":%s}' "$1" "$2")"`;
    const auth = `XAUTHORITY="$(cat ${shq(rootDir(displayNo) + '/xauth')} 2>/dev/null)"; export XAUTHORITY`;
    return `export DISPLAY=:${displayNo}; ${auth}; ${modelToScreenShell(input.x, input.y)}; ${HELPER} --port ${port} --request ${request}`;
  }
  return `${HELPER} --port ${port} --request ${shq(JSON.stringify(input))}`;
}

/** Validate one helper run: non-zero exits and `{ ok: false }` fail truthfully, never invented. */
export function parseBrowserOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  action: BrowserInput['action'],
): BrowserResult {
  if (exitCode !== 0) {
    throw browserDown(stdout, stderr) ?? failed(describeExit(action, exitCode, stdout, stderr));
  }
  const raw = parseJson(stdout, action);
  if (!isRecord(raw)) throw failed(`browser ${action} returned an unexpected result (not a JSON object)`);
  if (raw['ok'] !== true) throw browserDown(helperError(raw), '') ?? failed(`browser ${action} failed: ${helperError(raw)}`);
  const parsed = browserResultSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw failed(`browser ${action} returned an unexpected result: ${why}`);
  }
  if (parsed.data.action !== action) throw failed(`browser ${action} returned a ${parsed.data.action} result`);
  return parsed.data;
}

/** The helper's "no CDP on 127.0.0.1:<port>" means Chromium is not running on that display. */
function browserDown(...outputs: string[]): BrowserDownError | undefined {
  const match = /no CDP on 127\.0\.0\.1:(\d+)/i.exec(outputs.join('\n'));
  const port = match?.[1];
  return port === undefined ? undefined : new BrowserDownError(Number(port) - screenPorts(0).cdp);
}

function parseJson(stdout: string, action: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch {
    throw failed(`browser ${action} returned invalid JSON: ${tail(stdout)}`);
  }
}

function helperError(raw: Record<string, unknown>): string {
  const error = raw['error'];
  return typeof error === 'string' && error.length > 0 ? tail(error) : 'unknown helper error';
}

function describeExit(action: string, exitCode: number, stdout: string, stderr: string): string {
  const detail = tail(stderr.trim() || stdout.trim()) || 'no output';
  const missing = /no such file|not found/i.test(detail)
    ? ` (is ${BROWSER_HELPER} installed in this image?)`
    : '';
  return `browser ${action} failed (exit ${exitCode})${missing}: ${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function tail(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
