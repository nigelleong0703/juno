/**
 * Which calls act on the owner's Mac (My Mac). An agent has its sandbox and, when the owner allows it, the Mac too; each file or
 * shell call names the computer in `on` (default sandbox), and `computer_copy` names a `from` and a `to`. Everything the policy
 * and the approval cards say about the Mac follows from these arguments, never from a setting of the agent.
 */
import { posix } from 'node:path';
import { MAC_APP_TOOLS } from '../../../../modules/tools/tools/macApps.js';
import { MAC_DESKTOP_TOOL_NAMES } from '../../../../modules/tools/tools/computerMac.js';

/** The tools that run a command: on the owner's Mac every one of them asks first. */
export const MAC_COMMAND_TOOLS: ReadonlySet<string> = new Set(['shell.run', 'shell.start']);
/** The tools that take a path: on the owner's Mac a path outside ~/Juno asks first (reading as much as writing). */
export const MAC_PATH_TOOLS: ReadonlySet<string> = new Set(['files.read', 'files.write', 'files.edit', 'files.search']);
/** The tools that work an app on the owner's Mac through cua-driver: they are always on the Mac, and each names the `app`. */
export const MAC_DESKTOP_TOOLS: ReadonlySet<string> = MAC_DESKTOP_TOOL_NAMES;
/** The coordinate tools that used to reach the Mac's screen. On the Mac they are gone (use the three above); in the sandbox they are unchanged. */
export const SANDBOX_SCREEN_TOOLS: ReadonlySet<string> = new Set([
  'computer.screenshot', 'computer.click', 'computer.double_click', 'computer.right_click', 'computer.move', 'computer.type', 'computer.key', 'computer.scroll',
]);
/** Every tool with an `on` argument. */
const ON_TOOLS: ReadonlySet<string> = new Set([
  ...MAC_COMMAND_TOOLS,
  ...MAC_PATH_TOOLS,
  'shell.poll', 'shell.input', 'shell.stop', 'computer_environment',
  'computer.screenshot', 'computer.click', 'computer.double_click', 'computer.right_click', 'computer.move',
  'computer.type', 'computer.key', 'computer.scroll', 'computer.record_audio',
  'browser.tabs', 'browser.new_tab', 'browser.navigate', 'browser.snapshot', 'browser.get_text',
  'browser.click', 'browser.type', 'browser.fill', 'browser.advance', 'browser.dialog', 'request_secure_input', 'request_takeover',
]);

function arg(args: unknown, key: string): string {
  if (typeof args !== 'object' || args === null) return '';
  const value: unknown = Reflect.get(args, key);
  return typeof value === 'string' ? value : '';
}

/** Whether this call touches the Mac. */
export function usesMac(toolName: string, args: unknown): boolean {
  if (MAC_APP_TOOLS.has(toolName) || MAC_DESKTOP_TOOLS.has(toolName)) return true;
  if (toolName === 'computer_copy') return arg(args, 'from') === 'mac' || arg(args, 'to') === 'mac';
  return ON_TOOLS.has(toolName) && arg(args, 'on') === 'mac';
}

/** The app a desktop call names, as the owner reads it: a bundle id shows its last part ("com.apple.Notes" is "Notes"). */
export function macAppName(args: unknown): string {
  const app = arg(args, 'app').trim().replace(/\s+/g, ' ').slice(0, 80);
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app) ? (app.split('.').pop() ?? app) : app;
}

/** Whether a call asks for an app to come to the front (`computer.act` with `foreground`). */
export function wantsForeground(toolName: string, args: unknown): boolean {
  return toolName === 'computer.act' && typeof args === 'object' && args !== null && Reflect.get(args, 'foreground') === true;
}

/**
 * Whether a path a tool names stays in the agent's folder on the Mac. A relative path is resolved there by the tools, `..` is
 * folded out first. The Mac's daemon checks the real path again (symlinks), so this only decides what the owner is asked.
 */
export function insideMacFolder(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed === '') return true;
  const folded = posix.normalize(trimmed);
  if (!folded.startsWith('/') && !folded.startsWith('~')) return !folded.startsWith('..');
  return /^(~|\/Users\/[^/]+|\/home\/[^/]+)\/Juno(\/|$)/.test(folded);
}

/** The Mac-side paths of a `computer_copy` (the source when it comes from the Mac, the destination when it goes there) that are outside ~/Juno. */
export function copyPathsOutsideMac(args: unknown): string[] {
  const outside: string[] = [];
  if (arg(args, 'from') === 'mac' && !insideMacFolder(arg(args, 'path'))) outside.push(arg(args, 'path'));
  if (arg(args, 'to') === 'mac' && !insideMacFolder(arg(args, 'toPath'))) outside.push(arg(args, 'toPath'));
  return outside;
}
