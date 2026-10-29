/**
 * The screen-action dispatcher. Maps the serializable `ScreenAction` union onto the display's
 * command/file helpers so the provider's `act` is a one-liner and the switch lives here.
 *
 * It runs against the narrow `SandboxRuntime`, never the provider SDK: the caller adapts its
 * live handle (E2B via `e2b-runtime.ts`, local/docker via their own runtime) first.
 */
import type { SandboxRuntime } from './runtime.js';
import type { ScreenAction, ScreenActionResult } from './types.js';
import type { ScreenFile } from './screen-file.js';
import { shq, xdotoolClick, xdotoolMove, xdotoolScroll } from './screen-boot.js';
import { createSandboxProcesses } from './processes.js';
import { screenPorts } from './ports.js';
import { agentUser } from './isolation-user.js';
import { copyFromComputer, pasteToComputer } from './clipboard.js';
const JEV_SUPERVISOR = '/usr/bin/python3 /opt/juno/jev-browser/agent_jev_supervise.py';
function jevCommand(agentId: string, displayNo: number): string {
  const port = screenPorts(displayNo).cdp;
  return 'JUNO_JEV_CDP=' + shq('http://127.0.0.1:' + String(port)) + ' JUNO_JEV_AGENT_USER=' + shq(agentUser(agentId)) + ' ' + JEV_SUPERVISOR;
}

export async function runScreenAction(
  files: ScreenFile,
  runtime: SandboxRuntime,
  /** The platform's root runtime: browser calls run there, not as the agent (BACKEND 8.7). */
  root: SandboxRuntime,
  agentId: string,
  displayNo: number,
  action: ScreenAction,
  signal: AbortSignal,
): Promise<ScreenActionResult> {
  const display = (command: string) => files.runOnDisplay(runtime, displayNo, command);
  const processes = createSandboxProcesses(runtime);
  switch (action.kind) {
    case 'screenshot':
      return { screenshot: await files.screenshot(runtime, displayNo) };
    case 'click':
      await display(xdotoolClick(action.point, 1, 1));
      return {};
    case 'doubleClick':
      await display(xdotoolClick(action.point, 1, 2));
      return {};
    case 'rightClick':
      await display(xdotoolClick(action.point, 3, 1));
      return {};
    case 'move':
      await display(xdotoolMove(action.point));
      return {};
    case 'type':
      await display(`xdotool type --clearmodifiers --delay 1 -- ${shq(action.text)}`);
      return {};
    case 'key':
      await display(`xdotool key --clearmodifiers -- ${shq(action.key)}`);
      return {};
    case 'scroll':
      await display(xdotoolScroll(action.input));
      return {};
    case 'navigate':
      return { navigate: await files.navigate(root, agentId, displayNo, action.url) };
    case 'browser':
      return { browser: await files.browser(root, displayNo, action.input) };
    case 'meet':
      return { meet: await files.meet(root, displayNo, action.input) };
    case 'shell':
      return { shell: await files.shell(runtime, displayNo, action.input) };
    case 'readFile':
      return { fileRead: await files.readFile(runtime, action.path) };
    case 'writeFile':
      return { fileWrite: await files.writeFile(runtime, action.input) };
    case 'clipboardPaste':
      return { clipboardPaste: await pasteToComputer(runtime, agentId, displayNo, action.input) };
    case 'clipboardCopy':
      return { clipboardCopy: await copyFromComputer(root, runtime, displayNo, action.maxBytes) };
    case 'startProcess':
      return { process: { kind: 'started', snapshot: await processes.start(agentId, action.input, signal) } };
    case 'readProcess':
      return { process: { kind: 'read', output: await processes.read(agentId, action.input, signal) } };
    case 'writeProcess':
      return { process: { kind: 'write', result: await processes.write(agentId, action.input, signal) } };
    case 'stopProcess':
      return { process: { kind: 'stop', result: await processes.stop(agentId, action.input, signal) } };
    case 'startJevMcp': {
      await root.run('mkdir -p /run/juno/jev-mcp && chmod 0700 /run/juno/jev-mcp', { timeoutMs: 10_000, signal });
      const privileged = createSandboxProcesses(root, '/run/juno/jev-mcp');
      return { process: { kind: 'started', snapshot: await privileged.start(agentId, { command: jevCommand(agentId, displayNo) }, signal) } };
    }
    case 'readJevMcp': {
      const privileged = createSandboxProcesses(root, '/run/juno/jev-mcp');
      return { process: { kind: 'read', output: await privileged.read(agentId, action.input, signal) } };
    }
    case 'writeJevMcp': {
      const privileged = createSandboxProcesses(root, '/run/juno/jev-mcp');
      return { process: { kind: 'write', result: await privileged.write(agentId, action.input, signal) } };
    }
    case 'stopJevMcp': {
      const privileged = createSandboxProcesses(root, '/run/juno/jev-mcp');
      return { process: { kind: 'stop', result: await privileged.stop(agentId, action.input, signal) } };
    }
    default:
      return {};
  }
}
