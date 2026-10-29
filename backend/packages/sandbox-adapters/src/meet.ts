/**
 * Typed Google Meet actions for one agent display. The sandbox-local helper `/usr/local/bin/agent-meet` owns the CDP
 * session and the trusted OS clicks; this module builds its shell command and parses its one-JSON stdout, mirroring
 * browser.ts. Helper contract: argv `--port <cdp> --display <n> --request '<MeetInput json>'`; stdout
 * `{ ok: true, action, ... }` or `{ ok: false, error }` with a non-zero exit.
 */
import { meetResultSchema, type MeetInput, type MeetResult } from 'juno-agent/computer';
import { BrowserDownError, failed } from './errors.js';
import { screenPorts } from './ports.js';
import { rootDir, shq } from './screen-boot.js';

export { meetInputSchema, meetResultSchema } from 'juno-agent/computer';
export type { MeetInput, MeetResult } from 'juno-agent/computer';

export const MEET_HELPER = '/usr/local/bin/agent-meet';
/** A join waits for the page to load and for the post-click state; the helper's own budget is 45 s. */
export const MEET_TIMEOUT_MS = 60_000;

/**
 * Runs as root like agent-browser (it reaches the loopback CDP port), with the display's cookie from the root-only
 * record so xdotool can click on the agent's display.
 */
export function meetCommand(displayNo: number, input: MeetInput): string {
  const port = screenPorts(displayNo).cdp;
  const auth = `XAUTHORITY="$(cat ${shq(rootDir(displayNo) + '/xauth')} 2>/dev/null)"; export XAUTHORITY`;
  return `${auth}; ${MEET_HELPER} --port ${port} --display ${displayNo} --request ${shq(JSON.stringify(input))}`;
}

export function parseMeetOutput(stdout: string, stderr: string, exitCode: number, action: MeetInput['action']): MeetResult {
  if (exitCode !== 0) {
    const detail = tail(helperErrorOf(stdout) ?? (stderr.trim() || stdout.trim() || 'no output'));
    throw down(detail) ?? failed(`meet ${action} failed (exit ${exitCode})${/no such file|not found/i.test(detail) ? ` (is ${MEET_HELPER} installed in this image?)` : ''}: ${detail}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw failed(`meet ${action} returned invalid JSON: ${tail(stdout)}`);
  }
  if (typeof raw !== 'object' || raw === null) throw failed(`meet ${action} returned an unexpected result (not a JSON object)`);
  const record = raw as Record<string, unknown>;
  if (record['ok'] !== true) {
    const error = typeof record['error'] === 'string' && record['error'] ? tail(record['error']) : 'unknown helper error';
    throw down(error) ?? failed(`meet ${action} failed: ${error}`);
  }
  const parsed = meetResultSchema.safeParse(raw);
  if (!parsed.success) throw failed(`meet ${action} returned an unexpected result: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  if (parsed.data.action !== action) throw failed(`meet ${action} returned a ${parsed.data.action} result`);
  return parsed.data;
}

function helperErrorOf(stdout: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(stdout);
    const error = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['error'] : undefined;
    return typeof error === 'string' && error ? error : undefined;
  } catch {
    return undefined;
  }
}

function down(text: string): BrowserDownError | undefined {
  const match = /no CDP on 127\.0\.0\.1:(\d+)/i.exec(text);
  const port = match?.[1];
  return port === undefined ? undefined : new BrowserDownError(Number(port) - screenPorts(0).cdp);
}

function tail(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
