import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, Tool, ToolContext, WakeEvent } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { isFinalPurchaseLabel } from '../tools/computerBrowserActions.js';
import { clearBrowserObservationState } from '../computer/browser-observation.js';
import {
  ComputerError,
  createToolRegistry,
  type BrowserInput,
  type BrowserResult,
  type ComputerClient,
  type ComputerEnvironment,
  type FileContent,
  type FileWriteRequest,
  type FileWriteResult,
  type NavigateResult,
  type Point,
  type RecordAudioInput,
  type RecordAudioResult,
  type Screenshot,
  type ScrollInput,
  type ShellInput,
  type ShellOutput,
} from '../index.js';

const ALL_COMPUTER_TOOLS = [
  'computer.screenshot',
  'computer.click',
  'computer.double_click',
  'computer.right_click',
  'computer.move',
  'computer.type',
  'computer.key',
  'computer.scroll',
  'computer.record_audio',
  'browser.tabs',
  'browser.new_tab',
  'browser.navigate',
  'browser.snapshot',
  'browser.get_text',
  'browser.click',
  'browser.type',
  'browser.dialog',
  'request_secure_input',
  'request_takeover',
  'computer_environment',
  'shell.run',
  'files.read',
  'files.write',
];

/** Records what the tools ask for; one field per action so a test can assert the agent id and arguments. */
class FakeComputerClient implements ComputerClient {
  readonly calls: Array<{ action: string; agentId: string; args?: unknown }> = [];
  screen: Screenshot = { data: 'png-base64', mimeType: 'image/png', width: 1280, height: 800, displayNo: 3 };
  shell: ShellOutput = { stdout: 'hello', stderr: '', exitCode: 0 };
  file: FileContent = { content: 'file body', bytes: 9 };
  written: FileWriteResult = { path: '/workspace/note.md', bytes: 4 };
  page: NavigateResult = { url: 'https://example.com', title: 'Example' };
  failWith: ComputerError | undefined;
  failEnvWith: ComputerError | undefined;
  envCalls = 0;
  env: ComputerEnvironment = {
    os: 'FakeOS 0.0 fakearch',
    platform: 'fake',
    user: 'agent',
    home: '/home/agent',
    workingDirectory: '/workspace',
    pathStyle: 'posix',
    kind: 'sandbox',
  };

  private record(action: string, agentId: string, args?: unknown): void {
    this.calls.push(args === undefined ? { action, agentId } : { action, agentId, args });
    if (this.failWith) throw this.failWith;
  }

  async screenshot(agentId: string, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<Screenshot> {
    this.record('screenshot', agentId, on === undefined ? undefined : { on });
    return this.screen;
  }

  async click(agentId: string, input: Point, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('click', agentId, on === 'mac' ? { ...input, on } : input);
  }

  async doubleClick(agentId: string, input: Point, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('doubleClick', agentId, on === 'mac' ? { ...input, on } : input);
  }

  async rightClick(agentId: string, input: Point, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('rightClick', agentId, on === 'mac' ? { ...input, on } : input);
  }

  async move(agentId: string, input: Point, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('move', agentId, on === 'mac' ? { ...input, on } : input);
  }

  async type(agentId: string, text: string, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('type', agentId, on === 'mac' ? { text, on } : text);
  }

  async pressKey(agentId: string, key: string, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('pressKey', agentId, on === 'mac' ? { key, on } : key);
  }

  async scroll(agentId: string, input: ScrollInput, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<void> {
    this.record('scroll', agentId, on === 'mac' ? { ...input, on } : input);
  }

  async navigate(agentId: string, url: string, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<NavigateResult> {
    this.record('navigate', agentId, on === 'mac' ? { url, on } : url);
    return this.page;
  }

  async browser(agentId: string, input: BrowserInput, _signal?: AbortSignal, on?: 'sandbox' | 'mac'): Promise<BrowserResult> {
    this.record('browser', agentId, on === 'mac' ? { ...input, on } : input);
    switch (input.action) {
      case 'tabs':
        return { action: 'tabs', tabs: [{ tab: 't1', url: 'https://example.com', title: 'Example', active: true }] };
      case 'new_tab':
        return { action: 'new_tab', url: input.url ?? 'about:blank', title: 'Example', tab: 't2' };
      case 'snapshot':
        return { action: 'snapshot', url: 'https://example.com', title: 'Example', tab: input.tab ?? 't1', nodes: [], crossOriginFrames: 0 };
      case 'scroll':
        return { action: 'scroll', url: 'https://example.com', title: 'Example', tab: input.tab ?? 't1', scrolled: 500 };
      case 'get_text':
        return { action: 'get_text', url: 'https://example.com', title: 'Example', tab: input.tab ?? 't1', text: 'page text' };
      case 'navigate':
        return { action: 'navigate', url: input.url, title: 'Example', tab: input.tab ?? 't1' };
      case 'click':
        return { action: 'click', url: 'https://example.com', title: 'Example', tab: 't1', clicked: true };
      case 'type':
        return { action: 'type', url: 'https://example.com', title: 'Example', tab: 't1', typed: true };
      case 'bounds':
        return { action: 'bounds', url: 'https://example.com', title: 'Example', tab: 't1',
          elements: (input.refs ?? []).map((ref) => ({ ref, rect: { x: 400, y: 300, width: 300, height: 80 }, role: 'checkbox', name: "I'm not a robot" })) };
      case 'attrs':
        return { action: 'attrs', url: 'https://example.com', title: 'Example', tab: 't1', fields: input.refs.map((ref) => ({ ref, tag: 'input', type: 'text' })) };
      case 'secure_key':
        return { action: 'secure_key', alg: 'X25519-HKDF-SHA256-AES256GCM', keyId: 'k1', publicKey: 'cHVibGljLWtleS0zMi1ieXRlcy1sb25nLWV4YW1wbGU=' };
      case 'fill_secret':
        return { action: 'fill_secret', url: 'https://example.com', title: 'Example', tab: 't1', filled: true };
      case 'dialog':
        return { action: 'dialog', url: 'https://example.com', title: 'Example', tab: input.tab ?? 't1' };
      case 'point':
        return { action: 'point', url: 'https://example.com', title: 'Example', tab: 't1' };
      case 'notices':
        return { action: 'notices' };
    }
  }

  async recordAudio(agentId: string, input: RecordAudioInput): Promise<RecordAudioResult> {
    this.record('recordAudio', agentId, input);
    return { recordingId: 'rec-1', path: '/Users/robin/Juno/recordings/rec-1.wav', state: input.action === 'start' ? 'recording' : 'stopped' };
  }

  async runShell(agentId: string, input: ShellInput): Promise<ShellOutput> {
    this.record('runShell', agentId, input);
    return this.shell;
  }

  async readFile(agentId: string, path: string): Promise<FileContent> {
    this.record('readFile', agentId, path);
    return this.file;
  }

  async writeFile(agentId: string, input: FileWriteRequest): Promise<FileWriteResult> {
    this.record('writeFile', agentId, input);
    return this.written;
  }

  async environment(_agentId: string): Promise<ComputerEnvironment> {
    this.envCalls += 1;
    if (this.failEnvWith) throw this.failEnvWith;
    return this.env;
  }
}

class NoopEnqueuer implements Enqueuer {
  async enqueue(event: WakeEvent) {
    void event;
    return { accepted: true };
  }
  async stopRun() {}
  async resolveAwakeable() {}
  async scheduleRoutine() {}
}

const wake: WakeEvent = wakeEventSchema.parse({
  id: 'wk-1',
  ownerId: 'owner',
  agentId: 'agent-1',
  sessionKey: 'agent-1:conv-1',
  conversationId: 'conv-1',
  kind: 'user_message',
  origin: { type: 'user' },
  trusted: true,
  priority: 'user',
  payload: {},
  at: new Date().toISOString(),
});

function toolContext(store: Store, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    ownerId: 'owner',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    store,
    blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake,
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A System One whose reviewer question is answered with these probabilities (null: no model available). */
function reviewerSaying(probabilities: Record<string, number> | null) {
  return vi.fn(async (_state: string, _questions: unknown, _signal: AbortSignal) => {
    if (probabilities === null) return null;
    const [choice = 'unknown', top = 0] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? [];
    return { review: { type: 'choice' as const, choice, probabilities, confidence: top } };
  });
}
const PROCEED = { proceed: 0.95, commit: 0.03, unknown: 0.02 };
const COMMIT = { proceed: 0.05, commit: 0.9, unknown: 0.05 };

async function registryWith(computer?: () => ComputerClient | undefined) {
  // Observation baselines are module-global and keyed by the shared default scope: reset them so each
  // test starts from a full snapshot instead of a delta over the previous test's fixture.
  clearBrowserObservationState();
  const store = createMemoryStore();
  const registry = await createToolRegistry({
    store,
    enqueuer: new NoopEnqueuer(),
    ...(computer ? { computer } : {}),
  });
  return { store, registry };
}

function requireTool(registry: { get(name: string): Tool | undefined }, name: string): Tool {
  const tool = registry.get(name);
  expect(tool, name).toBeDefined();
  if (!tool) throw new Error(name + ' missing');
  return tool;
}

describe('computer tools registration', () => {
  it('hides every computer capability when no client is configured', async () => {
    const { registry } = await registryWith();
    const names = (await registry.forAgent('agent-1')).map((tool) => tool.name);
    expect(names.some((name) => name.includes('computer') || name.includes('browser') || name.includes('shell') || name.includes('files'))).toBe(false);
    expect(registry.get('computer.screenshot')).toBeUndefined();
  });

  it('registers the full computer toolset when a client is configured', async () => {
    const client = new FakeComputerClient();
    const { registry } = await registryWith(() => client);
    const names = (await registry.forAgent('agent-1')).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(ALL_COMPUTER_TOOLS));
  });

  it('only treats committed actions as replay:never', async () => {
    const client = new FakeComputerClient();
    const { registry } = await registryWith(() => client);
    const never = [
      'computer.click',
      'computer.double_click',
      'computer.right_click',
      'computer.move',
      'computer.type',
      'computer.key',
      'computer.scroll',
      'browser.new_tab',
      'browser.navigate',
      'browser.click',
      'browser.type',
      'shell.run',
      'files.write',
    ];
    for (const name of never) expect(requireTool(registry, name).replay, name).toBe('never');
    expect(requireTool(registry, 'computer.screenshot').replay).toBe('safe');
    expect(requireTool(registry, 'browser.snapshot').replay).toBe('safe');
    expect(requireTool(registry, 'browser.get_text').replay).toBe('safe');
    expect(requireTool(registry, 'browser.snapshot').sideEffect).toBe(false);
    expect(requireTool(registry, 'browser.get_text').sideEffect).toBe(false);
    expect(requireTool(registry, 'browser.tabs').replay).toBe('safe');
    expect(requireTool(registry, 'files.read').replay).toBe('safe');
    expect(requireTool(registry, 'computer_environment').replay).toBe('safe');
    expect(requireTool(registry, 'computer_environment').sideEffect).toBe(false);
  });
});

describe('computer tool behaviour', () => {
  let client: FakeComputerClient;
  let store: Store;
  let registry: Awaited<ReturnType<typeof registryWith>>['registry'];

  beforeEach(async () => {
    client = new FakeComputerClient();
    const built = await registryWith(() => client);
    store = built.store;
    registry = built.registry;
  });

  it('scopes every action to the requesting agent own screen, ignoring a spoofed agent id', async () => {
    const result = await requireTool(registry, 'computer.click').execute({ x: 10, y: 20, agentId: 'agent-2' }, toolContext(store));
    expect(result.isError).not.toBe(true);
    // The purchase gate first reads what is under the point (from this agent's own browser), then the click.
    expect(client.calls).toEqual([
      { action: 'browser', agentId: 'agent-1', args: { action: 'point', x: 10, y: 20 } },
      { action: 'click', agentId: 'agent-1', args: { x: 10, y: 20 } },
    ]);
  });

  it('runs shell, files and browser actions on the sandbox with their arguments', async () => {
    await requireTool(registry, 'shell.run').execute({ command: 'ls -la', timeoutMs: 5000 }, toolContext(store));
    await requireTool(registry, 'files.read').execute({ path: '/workspace/note.md' }, toolContext(store));
    await requireTool(registry, 'files.write').execute({ path: '/workspace/note.md', content: 'text' }, toolContext(store));
    await requireTool(registry, 'browser.navigate').execute({ url: 'https://example.com' }, toolContext(store));
    expect(client.calls.map((call) => [call.action, call.agentId])).toEqual([
      ['runShell', 'agent-1'],
      ['readFile', 'agent-1'],
      ['writeFile', 'agent-1'],
      ['browser', 'agent-1'],
      ['browser', 'agent-1'],
    ]);
    expect(client.calls[0]?.args).toEqual({ command: 'ls -la', timeoutMs: 5000, cwd: '/workspace' });
    expect(client.calls[3]?.args).toEqual({ action: 'navigate', url: 'https://example.com' });
    // The loaded page comes back with the navigation, so the model needs no separate snapshot turn.
    expect(client.calls[4]?.args).toEqual({ action: 'snapshot', tab: 't1', follow: true });
  });

  it('says a slow page is still loading instead of claiming it loaded', async () => {
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => ({ ...(await browse(agentId, input)), title: '', loading: true } as BrowserResult);
    const result = await requireTool(registry, 'browser.navigate').execute({ url: 'https://slow.example/' }, toolContext(store));
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('still loading');
    expect(result.details).toMatchObject({ loading: true });
  });

  it('reports a refused action as a tool error with the machine code', async () => {
    client.failWith = new ComputerError('not_allowed', 'navigation is blocked by policy');
    const result = await requireTool(registry, 'browser.navigate').execute({ url: 'https://example.com' }, toolContext(store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'not_allowed' });
    expect(JSON.stringify(result.content)).toContain('blocked by policy');
  });
});

describe('computer guard rails', () => {
  let client: FakeComputerClient;
  let store: Store;
  let registry: Awaited<ReturnType<typeof registryWith>>['registry'];

  beforeEach(async () => {
    client = new FakeComputerClient();
    const built = await registryWith(() => client);
    store = built.store;
    registry = built.registry;
  });

  it('answers a user takeover with a non-error pause, not an action', async () => {
    client.failWith = new ComputerError('user_control', 'the user has taken over this screen');
    const result = await requireTool(registry, 'computer.type').execute({ text: 'secret' }, toolContext(store));
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ code: 'user_control', paused: true });
    expect(JSON.stringify(result.content)).toContain('Paused: the user is in control');
    expect(client.calls).toHaveLength(1);
  });

  it('says which surface is paused and why: the Mac Stopped by the user, or a screen whose hand-back has not been looked at yet', async () => {
    client.failWith = new ComputerError('user_control', 'stopped', { surface: 'mac', holder: 'stopped' });
    const stopped = await requireTool(registry, 'computer.type').execute({ text: 'x' }, toolContext(store));
    expect(stopped.isError).toBeUndefined();
    expect(stopped.details).toMatchObject({ code: 'user_control', paused: true, surface: 'mac', holder: 'stopped' });
    expect(JSON.stringify(stopped.content)).toContain('Stopped by the user on the Mac');
    client.failWith = new ComputerError('user_control', 'look first', { surface: 'screen', holder: 'agent', reason: 'inspect_first' });
    const early = await requireTool(registry, 'computer.type').execute({ text: 'x' }, toolContext(store));
    expect(JSON.stringify(early.content)).toContain('Take a fresh screenshot or snapshot first');
  });

  it('reports a missing screen as a capability error', async () => {
    client.failWith = new ComputerError('no_screen', 'this agent has no screen allocated yet');
    const result = await requireTool(registry, 'computer.screenshot').execute({}, toolContext(store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'no_screen' });
  });

  it('explains that the computer is not configured when a client disappears after registration', async () => {
    let available = true;
    const built = await registryWith(() => (available ? client : undefined));
    available = false;
    const result = await requireTool(built.registry, 'computer.screenshot').execute({}, toolContext(built.store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'unavailable' });
    expect(JSON.stringify(result.content)).toContain('COMPUTERD_URL');
  });

  it('rethrows an abort so the run fence records an interruption instead of a tool error', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('aborted by stop', 'AbortError');
    controller.abort(abortError);
    client.failWith = new ComputerError('aborted', 'stopped');
    const ctx = toolContext(store, { signal: controller.signal });
    await expect(requireTool(registry, 'computer.click').execute({ x: 1, y: 2 }, ctx)).rejects.toBeTruthy();
  });

  it('rejects unknown arguments instead of acting on garbage coordinates', async () => {
    const tool = requireTool(registry, 'computer.click');
    await expect(tool.execute({ x: 'ten', y: 20 }, toolContext(store))).rejects.toThrow();
    await expect(tool.execute({ y: 20 }, toolContext(store))).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a non-http browser target', async () => {
    const tool = requireTool(registry, 'browser.navigate');
    await expect(tool.execute({ url: 'file:///etc/passwd' }, toolContext(store))).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it('reports a nonzero shell exit code as an error but keeps the output', async () => {
    client.shell = { stdout: 'partial', stderr: 'boom', exitCode: 2 };
    const result = await requireTool(registry, 'shell.run').execute({ command: 'false' }, toolContext(store));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('boom');
    expect(result.details).toMatchObject({ exitCode: 2 });
  });
});

describe('computer environment', () => {
  let client: FakeComputerClient;
  let store: Store;
  let registry: Awaited<ReturnType<typeof registryWith>>['registry'];

  beforeEach(async () => {
    client = new FakeComputerClient();
    const built = await registryWith(() => client);
    store = built.store;
    registry = built.registry;
  });

  it('renders the bound working directory, user and platform', async () => {
    client.env.workingDirectory = '/custom/base';
    const result = await requireTool(registry, 'computer_environment').execute({}, toolContext(store));
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('/custom/base');
    expect(result.details).toMatchObject({
      workingDirectory: '/custom/base',
      user: 'agent',
      pathStyle: 'posix',
      kind: 'sandbox',
    });
  });

  it('runs shell commands in the binding directory, never the local process', async () => {
    client.env.workingDirectory = '/custom/base';
    await requireTool(registry, 'shell.run').execute({ command: 'pwd' }, toolContext(store));
    expect(client.calls[0]?.args).toMatchObject({ command: 'pwd', cwd: '/custom/base' });
    expect(JSON.stringify(client.calls[0]?.args)).not.toContain(process.cwd());
  });

  it('resolves relative file paths against the same binding directory', async () => {
    client.env.workingDirectory = '/custom/base';
    await requireTool(registry, 'files.read').execute({ path: 'notes/a.md' }, toolContext(store));
    await requireTool(registry, 'files.write').execute({ path: 'notes/b.md', content: 'x' }, toolContext(store));
    expect(client.calls.map((call) => call.args)).toEqual([
      '/custom/base/notes/a.md',
      { path: '/custom/base/notes/b.md', content: 'x' },
    ]);
  });

  it('passes absolute file paths through untouched', async () => {
    await requireTool(registry, 'files.read').execute({ path: '/etc/hostname' }, toolContext(store));
    expect(client.calls[0]?.args).toBe('/etc/hostname');
  });

  it('reads the environment once per run', async () => {
    await requireTool(registry, 'shell.run').execute({ command: 'a' }, toolContext(store));
    await requireTool(registry, 'shell.run').execute({ command: 'b' }, toolContext(store));
    expect(client.envCalls).toBe(1);
    await requireTool(registry, 'shell.run').execute({ command: 'c' }, toolContext(store, { runId: 'run-2' }));
    expect(client.envCalls).toBe(2);
  });

  it('fails shell truthfully when the computer has no environment', async () => {
    client.failEnvWith = new ComputerError('unavailable', 'no computer is bound for this owner yet');
    const result = await requireTool(registry, 'shell.run').execute({ command: 'pwd' }, toolContext(store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'unavailable' });
    expect(client.calls).toHaveLength(0);
  });

  it('reports an environment read failure with its code', async () => {
    client.failEnvWith = new ComputerError('no_screen', 'this agent has no screen yet');
    const result = await requireTool(registry, 'computer_environment').execute({}, toolContext(store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'no_screen' });
  });

  it('rethrows an abort instead of masking it as a tool error', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stopped', 'AbortError'));
    client.failEnvWith = new ComputerError('aborted', 'stopped');
    const ctx = toolContext(store, { signal: controller.signal });
    await expect(requireTool(registry, 'shell.run').execute({ command: 'pwd' }, ctx)).rejects.toBeTruthy();
  });
});

describe('browser tools dispatch', () => {
  let client: FakeComputerClient;
  let store: Store;
  let registry: Awaited<ReturnType<typeof registryWith>>['registry'];

  beforeEach(async () => {
    client = new FakeComputerClient();
    const built = await registryWith(() => client);
    store = built.store;
    registry = built.registry;
  });

  it('reads a snapshot as untrusted text with the node refs', async () => {
    const result = await requireTool(registry, 'browser.snapshot').execute({}, toolContext(store));
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('untrusted data');
    expect(client.calls).toEqual([{ action: 'browser', agentId: 'agent-1', args: { action: 'snapshot' } }]);
  });

  it('shows form state, values, groups and headings, and a hint when a button is disabled', async () => {
    const browse = client.browser.bind(client);
    const nodes = [
      { role: 'heading', name: 'Choose your coverage', heading: 2 },
      { ref: 'e1', role: 'radio', name: 'AppleCare+', group: 'Add AppleCare+?', state: ['unchecked'] },
      { ref: 'e2', role: 'radio', name: 'No coverage', group: 'Add AppleCare+?', state: ['checked'] },
      { ref: 'e3', role: 'textbox', name: 'Postcode', state: ['required'], value: '238839' },
      { ref: 'e4', role: 'button', name: 'Continue', disabled: true },
    ];
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return page.action === 'snapshot' ? { ...page, nodes } as BrowserResult : page;
    };
    const text = JSON.stringify((await requireTool(registry, 'browser.snapshot').execute({}, toolContext(store))).content);
    expect(text).toContain('## Choose your coverage');
    expect(text).toContain('- e1 [radio] (Add AppleCare+?) AppleCare+ (unchecked)');
    expect(text).toContain('- e2 [radio] (Add AppleCare+?) No coverage (checked)');
    expect(text).toContain('- e3 [textbox] Postcode (required) = \\"238839\\"');
    expect(text).toContain('- e4 [button] Continue (disabled)');
    expect(text).toContain('Disabled buttons usually wait for a required choice');
  });

  it('shows the prose under a heading and points a nearly empty page at its text', async () => {
    const browse = client.browser.bind(client);
    const nodes = [
      { ref: 'e1', role: 'link', name: 'Apple' },
      { role: 'heading', name: 'We love that early energy.', heading: 2, text: 'Almost ready for you. Pre-order begins at 8pm SGT.' },
      { ref: 'e2', role: 'button', name: 'Shopping Bag' },
    ];
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return page.action === 'snapshot' ? { ...page, nodes } as BrowserResult : page;
    };
    const text = JSON.stringify((await requireTool(registry, 'browser.snapshot').execute({}, toolContext(store))).content);
    expect(text).toContain('## We love that early energy.\\nAlmost ready for you. Pre-order begins at 8pm SGT.');
    expect(text).toContain('read it with browser.get_text');
  });

  it('reads page text without acting on the screen', async () => {
    const result = await requireTool(registry, 'browser.get_text').execute({}, toolContext(store));
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('page text');
    expect(client.calls).toEqual([{ action: 'browser', agentId: 'agent-1', args: { action: 'get_text' } }]);
  });

  it('clicks and types by ref with a single attempt each, returning the page after each action', async () => {
    const clicked = await requireTool(registry, 'browser.click').execute({ ref: 'node-1' }, toolContext(store));
    const typed = await requireTool(registry, 'browser.type').execute({ ref: 'node-2', text: 'hello' }, toolContext(store));
    // No snapshot before the click: a new snapshot re-mints every ref and would make the model's ref stale.
    expect(client.calls).toEqual([
      { action: 'browser', agentId: 'agent-1', args: { action: 'click', ref: 'node-1' } },
      { action: 'browser', agentId: 'agent-1', args: { action: 'snapshot', tab: 't1', follow: true } },
      { action: 'browser', agentId: 'agent-1', args: { action: 'type', ref: 'node-2', text: 'hello' } },
      { action: 'browser', agentId: 'agent-1', args: { action: 'snapshot', tab: 't1', follow: true } },
    ]);
    for (const result of [clicked, typed]) {
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain('Snapshot of tab t1');
    }
  });

  it('refuses the final purchase click until it carries the order sentence, and lets ordinary shop clicks through', async () => {
    const browse = client.browser.bind(client);
    const nodes = [
      { ref: 'e1', role: 'button', name: 'Add to Bag' },
      { ref: 'e2', role: 'button', name: 'Place Order' },
      { ref: 'e3', role: 'link', name: 'Pay with Link' },
    ];
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return page.action === 'snapshot' ? { ...page, nodes } as BrowserResult : page;
    };
    // The gate reads labels from the snapshot the model was shown.
    await requireTool(registry, 'browser.snapshot').execute({}, toolContext(store));
    const click = requireTool(registry, 'browser.click');
    expect((await click.execute({ ref: 'e1' }, toolContext(store))).isError).toBeFalsy();
    expect((await click.execute({ ref: 'e3' }, toolContext(store, { systemOne: { ask: reviewerSaying(PROCEED) as never } }))).isError).toBeFalsy(); // a payment-method pick: the reviewer lets it through
    const refused = await click.execute({ ref: 'e2' }, toolContext(store));
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('confirm');
    expect(client.calls.filter((call) => (call.args as { action?: string }).action === 'click').map((call) => (call.args as { ref: string }).ref)).toEqual(['e1', 'e3']);
    const confirmed = await click.execute({ ref: 'e2', confirm: 'Place the order at apple.com/sg: iPhone 18 Pro Max, S$2,399' }, toolContext(store));
    expect(confirmed.isError).toBeFalsy();
    expect(client.calls.filter((call) => (call.args as { action?: string }).action === 'click').map((call) => (call.args as { ref: string }).ref)).toEqual(['e1', 'e3', 'e2']);
  });

  it('tells a final purchase button from browsing, cart and payment-method controls', () => {
    for (const label of ['Place Order', 'Place your order', 'Purchase', 'Pay', 'Pay now', 'Pay S$2,399', 'Complete purchase', 'Confirm and pay', 'Submit order']) {
      expect(isFinalPurchaseLabel(label), label).toBe(true);
    }
    for (const label of ['Buy', 'Buy iPhone', 'Add to Bag', 'Proceed to checkout', 'Checkout', 'Pay with Link', 'Payment methods', 'Shop iPhone']) {
      expect(isFinalPurchaseLabel(label), label).toBe(false);
    }
    expect(isFinalPurchaseLabel('Buy now')).toBe(false); // ambiguous: the reviewer decides
  });

  describe('purchase reviewer for ambiguous clicks', () => {
    const SAMSUNG = 'https://www.samsung.com/sg/smartphones/galaxy-s26-ultra/buy/';
    const AMAZON = 'https://www.amazon.com/dp/B0EXAMPLE';
    let reviewRuns = 0; // each case is its own run: verdicts are cached per run

    /** Shows `label` on `url`, then clicks it with a reviewer that answers `says`; returns what happened. */
    async function clickOn(url: string, label: string, says: Record<string, number> | null, extra: Record<string, unknown> = {}, ctxOverrides: Partial<ToolContext> = {}) {
      const browse = client.browser.bind(client);
      client.browser = async (agentId, input) => {
        const page = await browse(agentId, input);
        return page.action === 'snapshot' ? { ...page, url, nodes: [{ role: 'heading', name: 'Galaxy S26 Ultra', heading: 1 }, { ref: 'e1', role: 'button', name: label }] } as BrowserResult : page;
      };
      const ask = reviewerSaying(says);
      const context = toolContext(store, { systemOne: { ask: ask as never }, runId: `run-review-${++reviewRuns}`, ...ctxOverrides });
      await requireTool(registry, 'browser.snapshot').execute({}, context);
      const result = await requireTool(registry, 'browser.click').execute({ ref: 'e1', ...extra }, context);
      return { result, ask, context };
    }

    it('lets a confident proceed on "Buy now" through and records the verdict, giving the reviewer the page and the untrusted-data warning', async () => {
      const { result, ask } = await clickOn(SAMSUNG, 'Buy now', PROCEED);
      expect(result.isError).toBeFalsy();
      expect(result.details).toMatchObject({ purchaseReview: 'proceed', purchaseProbability: 0.95 });
      const state = ask.mock.calls[0]?.[0] ?? '';
      expect(state).toContain('www.samsung.com');
      expect(state).toContain('/sg/smartphones/galaxy-s26-ultra/buy/');
      expect(state).toContain('"Buy now"');
      expect(state).toContain('Galaxy S26 Ultra');
      expect(state.indexOf('untrusted')).toBeLessThan(state.indexOf('\nPage data\n'));
    });

    it.each([
      ['proceed at 0.6', { proceed: 0.6, commit: 0.3, unknown: 0.1 }, 'unsure', 0.6],
      ['proceed at 0.89', { proceed: 0.89, commit: 0.11, unknown: 0 }, 'unsure', 0.89],
      ['commit', COMMIT, 'commit', 0.05],
      ['unknown', { proceed: 0.2, commit: 0.1, unknown: 0.7 }, 'unsure', 0.2],
      ['no model', null, 'unavailable', undefined],
    ] as const)('refuses an Amazon "Buy Now" when the reviewer says %s', async (_name, says, verdict, probability) => {
      const { result } = await clickOn(AMAZON, 'Buy Now', says);
      expect(result.details).toMatchObject({ code: 'purchase_needs_confirm', purchaseReview: verdict, ...(probability === undefined ? {} : { purchaseProbability: probability }) });
      expect(client.calls.some((call) => (call.args as { action?: string }).action === 'click')).toBe(false);
    });

    it('refuses when the reviewer call throws', async () => {
      const { result } = await clickOn(AMAZON, 'Buy Now', PROCEED, {}, { systemOne: { ask: async () => { throw new Error('boom'); } } });
      expect(result.details).toMatchObject({ code: 'purchase_needs_confirm', purchaseReview: 'unavailable' });
    });

    it('refuses with no reviewer available at all', async () => {
      const { result } = await clickOn(AMAZON, 'Buy Now', PROCEED, {}, { systemOne: undefined as never });
      expect(result.details).toMatchObject({ code: 'purchase_needs_confirm', purchaseReview: 'unavailable' });
    });

    it('asks no reviewer for an unambiguous final label, a plain cart click, or a confirmed click', async () => {
      const placed = await clickOn(AMAZON, 'Place order', PROCEED);
      expect(placed.result.details).toMatchObject({ code: 'purchase_needs_confirm' });
      expect(placed.ask).not.toHaveBeenCalled();
      const cart = await clickOn(AMAZON, 'Add to cart', COMMIT);
      expect(cart.result.isError).toBeFalsy();
      expect(cart.ask).not.toHaveBeenCalled();
      const confirmed = await clickOn(AMAZON, 'Buy Now', COMMIT, { confirm: 'Buy the item at amazon.com, $20' });
      expect(confirmed.result.isError).toBeFalsy();
      expect(confirmed.ask).not.toHaveBeenCalled();
    });

    it('asks once per site, page and label within a run', async () => {
      const { ask, context } = await clickOn('https://shop.example/p/cache-test', 'Subscribe', COMMIT);
      const again = await requireTool(registry, 'browser.click').execute({ ref: 'e1' }, context);
      expect(again.details).toMatchObject({ purchaseReview: 'commit' });
      expect(ask).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the form in view when a long page would exceed the snapshot budget', async () => {
    const browse = client.browser.bind(client);
    const nodes: Array<{ ref?: string; role: string; name: string; state?: string[] }> = [];
    for (let i = 0; i < 1500; i++) nodes.push({ ref: `e${i}`, role: 'link', name: `Product link number ${i} with a long descriptive title` });
    for (let i = 0; i < 1500; i++) nodes.splice(750 + i, 0, { role: 'text', name: `Marketing sentence ${i} that fills the page` });
    nodes.splice(1500, 0, { role: 'text', name: 'We deliver in 3 days' }, { ref: 'e9001', role: 'textbox', name: 'Postal code', state: ['invalid', 'required'] }, { role: 'text', name: 'Enter 6 digits' }, { ref: 'e9002', role: 'button', name: 'Continue' });
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return page.action === 'snapshot' ? { ...page, nodes } as BrowserResult : page;
    };
    const run = async () => JSON.stringify((await requireTool(registry, 'browser.snapshot').execute({}, toolContext(store))).content);
    const text = await run();
    expect(text.length).toBeLessThan(26_000);
    for (const kept of ['Postal code', 'invalid, required', 'Enter 6 digits', 'We deliver in 3 days', 'Continue', 'Product link number 39 ']) expect(text).toContain(kept);
    expect(text).not.toContain('Product link number 40 ');
    expect(text).toMatch(/\d+ links and \d+ text lines left out to keep the form in view/);
    // An identical page reads back as a bounded unchanged note, and full:true restores the fitted list.
    const repeat = await run();
    expect(repeat.toLowerCase()).toContain('unchanged');
    expect(repeat.length).toBeLessThan(text.length / 2);
    const recovered = JSON.stringify((await requireTool(registry, 'browser.snapshot').execute({ full: true }, toolContext(store))).content);
    expect(recovered).toBe(text);
  });

  it('names the control a coordinate click landed on', async () => {
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return input.action === 'point' ? { ...page, element: { role: 'button', name: 'Add to cart' } } as BrowserResult : page;
    };
    const result = await requireTool(registry, 'computer.click').execute({ x: 10, y: 20 }, toolContext(store));
    expect(JSON.stringify(result.content)).toContain('Clicked \\"Add to cart\\" at (10, 20)');
  });

  it('fills a whole form in one call with a single snapshot at the end, and says where it stopped', async () => {
    const fill = requireTool(registry, 'browser.fill');
    const ok = await fill.execute({ fields: [{ ref: 'e1', text: 'Robin' }, { ref: 'e2', text: 'Singapore' }] }, toolContext(store));
    expect(ok.isError).toBeFalsy();
    expect(client.calls.map((call) => call.args)).toEqual([
      { action: 'type', ref: 'e1', text: 'Robin' },
      { action: 'type', ref: 'e2', text: 'Singapore' },
      { action: 'snapshot', tab: 't1', follow: true },
    ]);
    client.calls.length = 0;
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => {
      if (input.action === 'type' && input.ref === 'e2') throw new ComputerError('failed', 'unknown or stale ref e2');
      return browse(agentId, input);
    };
    const stopped = await fill.execute({ fields: [{ ref: 'e1', text: 'a' }, { ref: 'e2', text: 'b' }, { ref: 'e3', text: 'c' }] }, toolContext(store));
    expect(stopped.isError).toBe(true);
    expect(JSON.stringify(stopped.content)).toContain('Filled e1; stopped at e2');
    expect(client.calls.some((call) => (call.args as { ref?: string }).ref === 'e3')).toBe(false);
  });

  it('keeps a successful click when the follow-up snapshot fails, and says to take one', async () => {
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => {
      if (input.action === 'snapshot') throw new ComputerError('failed', 'snapshot timed out');
      return browse(agentId, input);
    };
    const result = await requireTool(registry, 'browser.click').execute({ ref: 'node-1' }, toolContext(store));
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('Clicked node-1');
    expect(JSON.stringify(result.content)).toContain('take browser.snapshot');
  });

  it('reports a stale ref as a tool error with the machine code', async () => {
    client.failWith = new ComputerError('failed', 'ref node-9 is stale; re-snapshot');
    const result = await requireTool(registry, 'browser.click').execute({ ref: 'node-9' }, toolContext(store));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('stale');
    // One click attempt, never retried (the read before it is the purchase check).
    expect(client.calls.filter((call) => (call.args as { action?: string }).action === 'click')).toHaveLength(1);
  });

  it('reports a dialog an action opened instead of a snapshot, and answers it through browser.dialog', async () => {
    const browse = client.browser.bind(client);
    const dialog = { tab: 't1', type: 'confirm' as const, message: 'Place order for $360?' };
    let open = true;
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      if (input.action === 'click') return { ...page, dialog } as BrowserResult;
      if (input.action === 'dialog' && input.accept === undefined && open) return { ...page, dialog } as BrowserResult;
      if (input.action === 'dialog' && input.accept !== undefined) {
        open = false;
        return { ...page, handled: { ...dialog, accepted: input.accept } } as BrowserResult;
      }
      return page;
    };
    const clicked = await requireTool(registry, 'browser.click').execute({ ref: 'e5' }, toolContext(store));
    expect(clicked.isError).toBeFalsy();
    expect(JSON.stringify(clicked.content)).toContain('confirm dialog is open on t1');
    expect(JSON.stringify(clicked.content)).toContain('browser.dialog');
    // The page is blocked: no snapshot was attempted after the click.
    expect(client.calls.map((call) => (call.args as { action: string }).action)).toEqual(['click']);

    const answer = requireTool(registry, 'browser.dialog');
    // Accepting a dialog that places an order is the final purchase step: it needs confirm, like the button.
    const refused = await answer.execute({ action: 'accept' }, toolContext(store));
    expect(refused.isError).toBe(true);
    expect(refused.details).toMatchObject({ code: 'purchase_needs_confirm' });
    expect(client.calls.some((call) => (call.args as { accept?: boolean }).accept !== undefined)).toBe(false);
    const accepted = await answer.execute({ action: 'accept', confirm: 'Place the order at demoblaze: 1 phone, $360' }, toolContext(store));
    expect(accepted.isError).toBeFalsy();
    expect(JSON.stringify(accepted.content)).toContain('Accepted the confirm dialog');
    expect(client.calls.at(-2)?.args).toEqual({ action: 'dialog', accept: true });
    expect(client.calls.at(-1)?.args).toEqual({ action: 'snapshot', tab: 't1', follow: true });
    // Nothing open any more: a second answer is a clear error, not a fake success.
    expect((await answer.execute({ action: 'dismiss' }, toolContext(store))).details).toMatchObject({ code: 'no_dialog' });
  });

  it('dismisses any dialog and accepts a harmless one without confirm', async () => {
    const browse = client.browser.bind(client);
    const dialog = { tab: 't1', type: 'prompt' as const, message: 'Your name?', defaultPrompt: '' };
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return input.action === 'dialog' && input.accept === undefined ? { ...page, dialog } as BrowserResult : page;
    };
    const answered = await requireTool(registry, 'browser.dialog').execute({ action: 'accept', text: 'Robin' }, toolContext(store, { systemOne: { ask: reviewerSaying(PROCEED) as never } }));
    expect(answered.isError).toBeFalsy();
    expect(client.calls.find((call) => (call.args as { accept?: boolean }).accept !== undefined)?.args).toEqual({ action: 'dialog', accept: true, text: 'Robin' });
  });

  describe('dialog reviewer for ambiguous confirms', () => {
    let dialogRuns = 0; // each case is its own run: verdicts are cached per run

    /** Opens a dialog on a page, then accepts it without confirm with a reviewer that answers `reply`. */
    async function acceptOn(type: 'confirm' | 'prompt' | 'alert', message: string, says: Record<string, number> | null) {
      const browse = client.browser.bind(client);
      const dialog = { tab: 't1', type, message };
      client.browser = async (agentId, input) => {
        const page = await browse(agentId, input);
        if (input.action === 'snapshot') return { ...page, url: 'https://shop.example/account/addresses', nodes: [{ role: 'heading', name: 'Saved addresses', heading: 1 }, { ref: 'e1', role: 'button', name: 'Edit address' }] } as BrowserResult;
        return input.action === 'dialog' && input.accept === undefined ? { ...page, url: 'https://shop.example/account/addresses', dialog } as BrowserResult : page;
      };
      const ask = reviewerSaying(says);
      const context = toolContext(store, { systemOne: { ask: ask as never }, runId: `run-dialog-${++dialogRuns}` });
      await requireTool(registry, 'browser.snapshot').execute({}, context);
      const result = await requireTool(registry, 'browser.dialog').execute({ action: 'accept' }, context);
      const accepted = client.calls.some((call) => (call.args as { accept?: boolean }).accept === true);
      return { result, ask, accepted };
    }

    it('accepts an ambiguous confirm the reviewer is confident is a proceed, giving it the message, the page and what was on it', async () => {
      const { result, ask, accepted } = await acceptOn('confirm', 'Are you sure?', PROCEED);
      expect(result.isError).toBeFalsy();
      expect(accepted).toBe(true);
      const state = ask.mock.calls[0]?.[0] ?? '';
      expect(state).toContain('"Are you sure?"');
      expect(state).toContain('shop.example');
      expect(state).toContain('/account/addresses');
      expect(state).toContain('Edit address');
      expect(state.indexOf('untrusted')).toBeLessThan(state.indexOf('\nPage data\n'));
    });

    it.each([[{ proceed: 0.3, commit: 0.1, unknown: 0.6 }, 'unsure'], [COMMIT, 'commit'], [null, 'unavailable']] as const)('refuses an ambiguous confirm when the reviewer says %j', async (says, verdict) => {
      const { result, accepted } = await acceptOn('confirm', 'Continue?', says);
      expect(result.details).toMatchObject({ code: 'purchase_needs_confirm', purchaseReview: verdict });
      expect(accepted).toBe(false);
    });

    it('refuses a committing message by rule without asking, and does not review a plain alert', async () => {
      const committing = await acceptOn('confirm', 'Delete this address permanently?', PROCEED);
      expect(committing.result.details).toMatchObject({ code: 'purchase_needs_confirm' });
      expect(committing.ask).not.toHaveBeenCalled();
      expect(committing.accepted).toBe(false);
      const alert = await acceptOn('alert', 'Saved', COMMIT);
      expect(alert.ask).not.toHaveBeenCalled();
      expect(alert.accepted).toBe(true);
    });
  });

  it('follows a popup the click opened and reports alerts that were accepted', async () => {
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      if (input.action === 'click') return { ...page, alerts: [{ tab: 't1', message: 'Product added' }], opened: [{ tab: 't3', opener: 't1' }] } as BrowserResult;
      if (input.action === 'snapshot') {
        return { ...page, tab: 't3', title: 'Sign in - Google Accounts', url: 'https://accounts.google.com/',
          nodes: [{ ref: 'e9', role: 'textbox', name: 'Email', site: 'accounts.google.com' }] } as BrowserResult;
      }
      return page;
    };
    const result = await requireTool(registry, 'browser.click').execute({ ref: 'e77' }, toolContext(store));
    const text = JSON.stringify(result.content);
    expect(text).toContain('Product added');
    expect(text).toContain('Opened a new tab t3 from t1');
    expect(text).toContain('Now on tab t3: Sign in - Google Accounts (https://accounts.google.com/)');
    expect(text).toContain('e9 [textbox] Email (in iframe accounts.google.com)');
    expect(result.details).toMatchObject({ nowOn: 't3' });
  });

  it('adds what the browser did meanwhile to a screenshot, e.g. an alert that was accepted on its own', async () => {
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => (input.action === 'notices'
      ? { action: 'notices', alerts: [{ tab: 't1', message: 'Product added' }] }
      : browse(agentId, input));
    const result = await requireTool(registry, 'computer.screenshot').execute({}, toolContext(store));
    expect(result.content.map((block) => block.type)).toEqual(['text', 'image', 'text']);
    expect(JSON.stringify(result.content.at(-1))).toContain('Product added');
    // A browser that cannot answer never costs the screenshot.
    client.browser = async () => { throw new ComputerError('failed', 'no CDP'); };
    expect((await requireTool(registry, 'computer.screenshot').execute({}, toolContext(store))).content.map((block) => block.type)).toEqual(['text', 'image']);
  });

  it('gates a coordinate click on a final purchase button the same way as browser.click', async () => {
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return input.action === 'point' && input.x === 700 ? { ...page, element: { role: 'button', name: 'Place Order' } } as BrowserResult : page;
    };
    const click = requireTool(registry, 'computer.click');
    const refused = await click.execute({ x: 700, y: 500 }, toolContext(store));
    expect(refused.isError).toBe(true);
    expect(refused.details).toMatchObject({ code: 'purchase_needs_confirm', element: { name: 'Place Order' } });
    expect(client.calls.some((call) => call.action === 'click')).toBe(false);
    // Elsewhere on the page, or confirmed, the click goes through.
    expect((await click.execute({ x: 100, y: 100 }, toolContext(store))).isError).toBeFalsy();
    expect((await click.execute({ x: 700, y: 500, confirm: 'Place the order: 1 phone, $360' }, toolContext(store))).isError).toBeFalsy();
    expect(client.calls.filter((call) => call.action === 'click').map((call) => call.args)).toEqual([{ x: 100, y: 100 }, { x: 700, y: 500 }]);
    // A right click never presses a button; a browser that cannot be read never blocks the screen.
    client.calls.length = 0;
    await requireTool(registry, 'computer.right_click').execute({ x: 700, y: 500 }, toolContext(store));
    expect(client.calls.map((call) => call.action)).toEqual(['rightClick']);
    client.browser = async () => { throw new ComputerError('failed', 'no CDP'); };
    expect((await click.execute({ x: 700, y: 500 }, toolContext(store))).isError).toBeFalsy();
  });

  it('gates Enter on a focused purchase button and a coordinate click that may answer a committing dialog', async () => {
    const browse = client.browser.bind(client);
    let mode: 'focus' | 'dialog' = 'focus';
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      if (input.action !== 'point') return page;
      return mode === 'focus' && input.x === undefined
        ? { ...page, element: { role: 'button', name: 'Pay now' } } as BrowserResult
        : { ...page, dialog: { tab: 't1', type: 'confirm', message: 'Delete this address permanently?' } } as BrowserResult;
    };
    const key = requireTool(registry, 'computer.key');
    expect((await key.execute({ key: 'Return' }, toolContext(store))).details).toMatchObject({ code: 'purchase_needs_confirm' });
    expect((await key.execute({ key: 'Tab' }, toolContext(store))).isError).toBeFalsy();
    expect((await requireTool(registry, 'computer.type').execute({ text: 'ok\n' }, toolContext(store))).details).toMatchObject({ code: 'purchase_needs_confirm' });
    mode = 'dialog';
    expect((await requireTool(registry, 'computer.click').execute({ x: 5, y: 5 }, toolContext(store))).details).toMatchObject({ code: 'purchase_needs_confirm' });
    expect(client.calls.filter((call) => call.action !== 'browser').map((call) => call.action)).toEqual(['pressKey']);
  });

  it('judges Enter in a text field as a click on its form\'s submit button: a purchase form needs confirm, a search box does not', async () => {
    const browse = client.browser.bind(client);
    let focus: { element: { role: string; name: string }; submit?: { role: string; name: string } } = { element: { role: 'textbox', name: 'Name on card' }, submit: { role: 'button', name: 'Place order' } };
    client.browser = async (agentId, input) => {
      const page = await browse(agentId, input);
      return input.action === 'point' && input.x === undefined ? { ...page, ...focus } as BrowserResult : page;
    };
    const key = requireTool(registry, 'computer.key');
    const type = requireTool(registry, 'computer.type');
    const pressed = () => client.calls.filter((call) => call.action === 'pressKey').length;

    // Return (or Enter, or a typed newline) in a field of a purchase form is the final purchase click: refused until confirmed.
    for (const run of [() => key.execute({ key: 'Return' }, toolContext(store)), () => key.execute({ key: 'KP_Enter' }, toolContext(store)), () => type.execute({ text: 'Mira\n' }, toolContext(store))]) {
      const refused = await run();
      expect(refused.isError).toBe(true);
      expect(refused.details).toMatchObject({ code: 'purchase_needs_confirm', submit: { name: 'Place order' } });
    }
    expect(pressed()).toBe(0);
    // With the confirm sentence the tool lets it through (the policy then asks the user, as for the click).
    expect((await key.execute({ key: 'Return', confirm: 'Place the order: 1 phone, $360' }, toolContext(store))).isError).toBeFalsy();
    expect(pressed()).toBe(1);
    // Space in a field only types a space.
    expect((await key.execute({ key: 'space' }, toolContext(store))).isError).toBeFalsy();

    // A search box: its form's button is a plain "Search", so Return goes through; so does a field whose form has no button.
    focus = { element: { role: 'searchbox', name: 'Search products' }, submit: { role: 'button', name: 'Search' } };
    expect((await key.execute({ key: 'Return' }, toolContext(store))).isError).toBeFalsy();
    focus = { element: { role: 'textbox', name: 'Search' } };
    expect((await key.execute({ key: 'Return' }, toolContext(store))).isError).toBeFalsy();
    // The label of the field itself is not what Enter presses: a field named like a commit does not block a plain submit.
    focus = { element: { role: 'textbox', name: 'Confirm email' }, submit: { role: 'button', name: 'Continue' } };
    expect((await key.execute({ key: 'Return' }, toolContext(store))).isError).toBeFalsy();
  });

  it('reports missing browser support as unavailable instead of faking it', async () => {
    // A client from before browser support: every other method present, no browser method.
    const legacy: ComputerClient = {
      screenshot: (agentId) => client.screenshot(agentId),
      click: (agentId, input) => client.click(agentId, input),
      type: (agentId, text) => client.type(agentId, text),
      pressKey: (agentId, key) => client.pressKey(agentId, key),
      scroll: (agentId, input) => client.scroll(agentId, input),
      navigate: (agentId, url) => client.navigate(agentId, url),
      runShell: (agentId, input) => client.runShell(agentId, input),
      readFile: (agentId, path) => client.readFile(agentId, path),
      writeFile: (agentId, input) => client.writeFile(agentId, input),
      environment: (agentId) => client.environment(agentId),
    };
    const built = await registryWith(() => legacy);
    const result = await requireTool(built.registry, 'browser.snapshot').execute({}, toolContext(built.store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'unavailable' });
  });
});

describe('asking the user on the computer', () => {
  let client: FakeComputerClient;
  let store: Store;
  let registry: Awaited<ReturnType<typeof registryWith>>['registry'];

  beforeEach(async () => {
    client = new FakeComputerClient();
    const built = await registryWith(() => client);
    store = built.store;
    registry = built.registry;
  });

  const fields = [
    { label: 'Card number', kind: 'card_number', ref: 'e12' },
    { label: 'CVC', kind: 'card_cvc', ref: 'e14' },
  ];

  it('raises a secure-input request naming the page fields, offering the sandbox key, and suspends on it', async () => {
    await store.put('secureVault', { id: 'secure-vault-owner', entries: [{ id: 'v-card', label: 'Visa 4242', kind: 'card' }, { id: 'v-pw', label: 'Shopee password', kind: 'password' }], updatedAt: '2026-10-15T00:00:00.000Z' });
    const result = await requireTool(registry, 'request_secure_input').execute({
      reason: 'Pay for the order',
      // A vault entry the owner has is kept; one they do not have is dropped.
      fields: [{ ...fields[0], vaultId: 'v-card' }, { ...fields[1], vaultId: 'missing' }],
    }, toolContext(store));
    expect(client.calls).toEqual([
      { action: 'browser', agentId: 'agent-1', args: { action: 'bounds', refs: ['e12', 'e14'] } },
      { action: 'browser', agentId: 'agent-1', args: { action: 'secure_key' } },
      { action: 'browser', agentId: 'agent-1', args: { action: 'attrs', refs: ['e12', 'e14'] } },
    ]);
    const request = (await store.list('requests', { limit: 5 })).items[0];
    expect(request).toMatchObject({ kind: 'secure_input', status: 'pending', runId: 'run-1', conversationId: 'conv-1' });
    expect(request?.payload).toEqual({
      kind: 'secure_input', site: 'example.com', url: 'https://example.com', reason: 'Pay for the order',
      fields: [{ id: 'f1', label: 'Card number', kind: 'card_number', ref: 'e12', vaultId: 'v-card' }, { id: 'f2', label: 'CVC', kind: 'card_cvc', ref: 'e14' }],
      encryption: { alg: 'X25519-HKDF-SHA256-AES256GCM', keyId: 'k1', publicKey: 'cHVibGljLWtleS0zMi1ieXRlcy1sb25nLWV4YW1wbGU=' },
    });
    expect(result.suspend).toEqual({ reason: 'user', awakeableId: request?.id });
    expect((await store.list('items', { limit: 5 })).items.map((item) => item.type)).toEqual(['request']);
  });

  it('refuses a request that holds a profile field, naming it, and raises nothing', async () => {
    const result = await requireTool(registry, 'request_secure_input').execute({
      reason: 'Sign up',
      fields: [{ label: 'Email address', ref: 'e12' }, { label: 'Password', ref: 'e14' }, { label: 'Postal code', ref: 'e15' }],
    }, toolContext(store));
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("Email address is profile data");
    expect(text).toContain('Postal code is profile data');
    expect(text).toContain('profile_update');
    expect(text).not.toContain('Password is profile');
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('raises nothing, and never asks in chat, when the computer cannot offer an encryption key', async () => {
    const original = client.browser.bind(client);
    client.browser = async (agentId, input) => {
      if (input.action === 'secure_key') throw new ComputerError('failed', 'unknown action');
      return original(agentId, input);
    };
    const result = await requireTool(registry, 'request_secure_input').execute({ reason: 'Pay', fields }, toolContext(store));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Do not ask for the value in chat');
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('raises nothing for a stale ref or a ref used twice', async () => {
    const tool = requireTool(registry, 'request_secure_input');
    const twice = await tool.execute({ reason: 'Sign in', fields: [fields[0], { ...fields[1], ref: 'e12' }] }, toolContext(store));
    expect(twice.isError).toBe(true);
    client.failWith = new ComputerError('failed', "unknown or stale ref 'e12': take a fresh browser.snapshot");
    const stale = await tool.execute({ reason: 'Sign in', fields }, toolContext(store));
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('stale');
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('asks for a focused take-over with the stuck element rect in screen pixels', async () => {
    const result = await requireTool(registry, 'request_takeover').execute({ reason: 'Solve the captcha', ref: 'e7' }, toolContext(store));
    const request = (await store.list('requests', { limit: 5 })).items[0];
    expect(request?.kind).toBe('computer');
    expect(request?.payload).toMatchObject({
      kind: 'computer', reason: 'Solve the captcha', site: 'example.com',
      focus: { rect: { x: 400, y: 300, width: 300, height: 80 }, role: 'checkbox', label: "I'm not a robot", ref: 'e7' },
    });
    expect(result.suspend).toEqual({ reason: 'user', awakeableId: request?.id });
  });

  it('requests full-screen takeover when optional element focus is stale or has no layout', async () => {
    for (const message of ["Node is detached from document", "Node does not have a layout object", "unknown or stale ref 'e7': take a fresh browser.snapshot"]) {
      client.failWith = new ComputerError('failed', message);
      const result = await requireTool(registry, 'request_takeover').execute({ reason: 'Solve the captcha', ref: 'e7' }, toolContext(store));
      expect(result.isError).not.toBe(true);
      expect(result.suspend?.reason).toBe('user');
      const requests = (await store.list('requests', { limit: 10 })).items;
      const request = requests.find(request => request.id === result.suspend?.awakeableId);
      expect(request?.payload).toEqual({ kind: 'computer', reason: 'Solve the captcha' });
    }
  });

  it('does not turn permission, offline or cancellation failures into a takeover request', async () => {
    for (const code of ['not_allowed', 'unavailable', 'user_control', 'failed'] as const) {
      client.failWith = new ComputerError(code, 'screen is unavailable');
      await requireTool(registry, 'request_takeover').execute({ reason: 'Help', ref: 'e7' }, toolContext(store));
      expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
    }
    const abort = new AbortController(); abort.abort(new Error('cancelled'));
    client.failWith = new ComputerError('failed', 'Node is detached from document');
    await expect(requireTool(registry, 'request_takeover').execute({ reason: 'Help', ref: 'e7' }, { ...toolContext(store), signal: abort.signal })).rejects.toThrow();
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
  });

  it('refuses both from a child task, which cannot reach the user', async () => {
    await store.put('runs', {
      id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', parentRunId: 'run-0', title: 't', status: 'running', kind: 'chat', steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    });
    expect((await requireTool(registry, 'request_takeover').execute({ reason: 'x' }, toolContext(store))).isError).toBe(true);
    expect((await requireTool(registry, 'request_secure_input').execute({ reason: 'x', fields }, toolContext(store))).isError).toBe(true);
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('gives a confirmed purchase click a screenshot preview in the library and the order fields', async () => {
    const at = new Date().toISOString();
    await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: ['owner'], unreadCount: 0, lastItemAt: at, createdAt: at });
    const purchase = { merchant: 'Apple Store (apple.com/sg)', items: [{ name: 'iPhone 18 Pro Max 512GB', quantity: 1, price: 'S$2,399.00' }], total: 'S$2,399.00', currency: 'SGD' };
    const click = requireTool(registry, 'browser.click');
    const details = await click.approvalDetails?.({ ref: 'e2', confirm: 'Place the order', purchase }, toolContext(store));
    expect(details?.purchase).toEqual(purchase);
    expect(details?.ui).toEqual({
      version: 1,
      text: 'Place this order at Apple Store (apple.com/sg)?\n\n• iPhone 18 Pro Max 512GB ×1 S$2,399.00\nTotal: S$2,399.00\nWarning: Approving lets the agent place this order and pay S$2,399.00.\n[Image: The page as it is now]',
      title: 'Place this order at Apple Store (apple.com/sg)?',
      blocks: [
        { type: 'items', rows: [{ name: 'iPhone 18 Pro Max 512GB', quantity: 1, price: 'S$2,399.00' }], total: { label: 'Total', value: 'S$2,399.00' } },
        { type: 'notice', tone: 'warning', text: 'Approving lets the agent place this order and pay S$2,399.00.' },
        { type: 'image', libraryId: details?.preview?.libraryId, caption: 'The page as it is now' },
      ],
    });
    const saved = await store.forOwner?.('owner').get('library', details?.preview?.libraryId ?? '');
    expect(saved).toMatchObject({ kind: 'image', mimeType: 'image/png', conversationId: 'conv-1', tags: ['approval-preview'] });
    expect(saved?.blobKey).toMatch(/^blobs\/[0-9a-f]{64}$/);
  });
});


describe('Mac screen target regression', () => {
  it('routes an explicit Mac screenshot to the Mac, never the sandbox', async () => {
    const client = new FakeComputerClient();
    const { store, registry } = await registryWith(() => client);
    await requireTool(registry, 'computer.screenshot').execute({ on: 'mac' }, toolContext(store));
    expect(client.calls.find((call) => call.action === 'screenshot')?.args).toEqual({ on: 'mac' });
  });

  it('carries the Mac target through browser follow-up snapshots', async () => {
    const client = new FakeComputerClient();
    const { store, registry } = await registryWith(() => client);
    await requireTool(registry, 'browser.navigate').execute({ url: 'https://example.com', on: 'mac' }, toolContext(store));
    const browserCalls = client.calls.filter((call) => call.action === 'browser');
    expect(browserCalls.map((call) => call.args)).toEqual([
      { action: 'navigate', url: 'https://example.com', on: 'mac' },
      { action: 'snapshot', tab: 't1', follow: true, on: 'mac' },
    ]);
  });

  it('uses the Mac for the browser point check and the native action', async () => {
    const client = new FakeComputerClient();
    const { store, registry } = await registryWith(() => client);
    await requireTool(registry, 'computer.click').execute({ x: 12, y: 34, on: 'mac' }, toolContext(store));
    expect(client.calls.map((call) => [call.action, call.args])).toEqual([
      ['browser', { action: 'point', x: 12, y: 34, on: 'mac' }],
      ['click', { x: 12, y: 34, on: 'mac' }],
    ]);
  });

  it('keeps the Mac target for dialog reads, answers and their snapshot', async () => {
    const client = new FakeComputerClient();
    const browse = client.browser.bind(client);
    const seen: Array<Record<string, unknown>> = [];
    client.browser = async (agentId, input, signal, on) => {
      seen.push({ ...input, ...(on === undefined ? {} : { on }) });
      if (input.action !== 'dialog') return browse(agentId, input, signal, on);
      const url = 'https://example.com';
      return input.accept === undefined
        ? { action: 'dialog', url, title: 'Example', tab: 't1', dialog: { tab: 't1', type: 'alert', message: 'Saved' } }
        : { action: 'dialog', url, title: 'Example', tab: 't1', handled: { tab: 't1', type: 'alert', message: 'Saved', accepted: true } };
    };
    const { store, registry } = await registryWith(() => client);
    await requireTool(registry, 'browser.dialog').execute({ action: 'accept', on: 'mac' }, toolContext(store));
    expect(seen).toEqual([
      { action: 'dialog', on: 'mac' },
      { action: 'dialog', accept: true, on: 'mac' },
      { action: 'snapshot', tab: 't1', follow: true, on: 'mac' },
    ]);
  });

  it('never uses a sandbox purchase snapshot to classify a Mac control', async () => {
    const client = new FakeComputerClient();
    const browse = client.browser.bind(client);
    client.browser = async (agentId, input, signal, on) => {
      if (input.action === 'snapshot') {
        return on === 'mac'
          ? { action: 'snapshot', url: 'https://shop.test/product', title: 'Product', tab: 't1', nodes: [{ ref: 'e1', role: 'button', name: 'Continue' }], crossOriginFrames: 0 }
          : { action: 'snapshot', url: 'https://shop.test/checkout', title: 'Checkout', tab: 't1', nodes: [{ ref: 'e1', role: 'button', name: 'Continue' }], crossOriginFrames: 0 };
      }
      return browse(agentId, input, signal, on);
    };
    const { store, registry } = await registryWith(() => client);
    await requireTool(registry, 'browser.snapshot').execute({}, toolContext(store));
    await requireTool(registry, 'browser.snapshot').execute({ on: 'mac' }, toolContext(store));
    const click = requireTool(registry, 'browser.click');
    expect((await click.execute({ ref: 'e1', on: 'mac' }, toolContext(store))).isError).toBeFalsy();
    expect((await click.execute({ ref: 'e1' }, toolContext(store))).details).toMatchObject({ code: 'purchase_needs_confirm' });
  });

  it('records on the Mac with the bounded default and stops without confirmation', async () => {
    const client = new FakeComputerClient();
    const { store, registry } = await registryWith(() => client);
    const audio = requireTool(registry, 'computer.record_audio');
    const started = await audio.execute({ on: 'mac', action: 'start' }, toolContext(store));
    expect(started.details).toEqual({ recordingId: 'rec-1', path: '/Users/robin/Juno/recordings/rec-1.wav', state: 'recording' });
    const stopped = await audio.execute({ on: 'mac', action: 'stop', recordingId: 'rec-1' }, toolContext(store));
    expect(stopped.details).toMatchObject({ recordingId: 'rec-1', state: 'stopped' });
    expect(client.calls.filter((call) => call.action === 'recordAudio').map((call) => call.args)).toEqual([
      { action: 'start', maxDurationSeconds: 1800 },
      { action: 'stop', recordingId: 'rec-1' },
    ]);
    const sandbox = await audio.execute({ action: 'start' }, toolContext(store));
    expect(sandbox).toMatchObject({ isError: true, details: { code: 'unavailable', computer: 'sandbox' } });
    expect(client.calls.filter((call) => call.action === 'recordAudio')).toHaveLength(2);
    await expect(audio.execute({ on: 'mac', action: 'start', maxDurationSeconds: 3601 }, toolContext(store))).rejects.toThrow();
  });

  it('refuses Mac secure input and takeover without touching the sandbox browser', async () => {
    const client = new FakeComputerClient();
    const { store, registry } = await registryWith(() => client);
    const secure = await requireTool(registry, 'request_secure_input').execute({ on: 'mac', reason: 'Sign in', fields: [{ label: 'Password', ref: 'e1' }] }, toolContext(store));
    const takeover = await requireTool(registry, 'request_takeover').execute({ on: 'mac', reason: 'Captcha', ref: 'e2' }, toolContext(store));
    expect(secure.details).toMatchObject({ code: 'unavailable', computer: 'mac' });
    expect(takeover.details).toMatchObject({ code: 'unavailable', computer: 'mac' });
    expect(client.calls).toEqual([]);
  });
});
