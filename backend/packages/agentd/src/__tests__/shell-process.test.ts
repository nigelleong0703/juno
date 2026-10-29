/**
 * Regression evidence for the sandbox-bound async process tools. Three layers are exercised: the tool
 * layer over a fake ComputerClient (scope, bounded cursor, stop), the real agentd client bridge to
 * computerd's process routes, and the sandbox seam itself running a real detached \`sh\` process
 * (start / poll / stdin / stop, real exit codes, cross-agent refusal, expired handles, cleanup).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxProcesses } from '@agent-desktop/sandbox-adapters';
import type { Store } from '@agent-desktop/contracts';
import type { ProcessStartInput } from '@agent-desktop/sandbox-adapters';
import { SandboxFiles, build, requireTool, textOf, toolCtx } from 'juno-agent/modules/tools/__tests__/codingFixtures';
import { LocalRuntime, ProcessSandboxClient } from './shellProcessFixtures.js';

type Registry = Awaited<ReturnType<typeof build>>['registry'];
const signal = () => new AbortController().signal;

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('shell process tools registry', () => {
  it('registers the process tools with a sandbox and marks replay correctly', async () => {
    const { registry } = await build(new ProcessSandboxClient());
    const names = (await registry.forAgent('agent-1')).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['shell.start', 'shell.poll', 'shell.input', 'shell.stop']));
    expect(registry.get('shell.poll')?.replay).toBe('safe');
    for (const name of ['shell.start', 'shell.input', 'shell.stop']) {
      expect(registry.get(name)?.replay, name).toBe('never');
      expect(registry.get(name)?.sideEffect, name).toBe(true);
    }
    const { registry: bare } = await build();
    expect(bare.get('shell.start')).toBeUndefined();
  });

  it('reports process control unavailable when the client exposes no async processes', async () => {
    const { store, registry } = await build(new SandboxFiles());
    const result = await requireTool(registry, 'shell.start').execute({ command: 'ls' }, toolCtx(store));
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: 'unavailable' });
  });
});

describe('shell process tools over a sandbox client', () => {
  let client: ProcessSandboxClient;
  let store: Store;
  let registry: Registry;

  beforeEach(async () => {
    client = new ProcessSandboxClient();
    const built = await build(client);
    store = built.store; registry = built.registry;
  });

  it('starts, polls bounded output, sends input and stops, scoped to the context agent', async () => {
    const started = await requireTool(registry, 'shell.start').execute({ command: 'cat', agentId: 'agent-2' }, toolCtx(store));
    const handle = String(started.details?.handle);
    expect(handle).toMatch(/^p_[0-9a-f]{12}$/);
    const first = await requireTool(registry, 'shell.poll').execute({ handle, maxBytes: 8 }, toolCtx(store));
    expect(textOf(first)).toBe('started:');
    expect(first.details).toMatchObject({ state: 'running', truncated: true, cursor: 8 });
    const input = await requireTool(registry, 'shell.input').execute({ handle, data: 'hello' }, toolCtx(store));
    expect(input.details).toMatchObject({ bytes: 5 });
    const next = await requireTool(registry, 'shell.poll').execute({ handle, cursor: Number(first.details?.cursor) }, toolCtx(store));
    expect(textOf(next)).toContain('hello');
    const stopped = await requireTool(registry, 'shell.stop').execute({ handle }, toolCtx(store));
    expect(stopped.details).toMatchObject({ state: 'stopped', exitCode: 143 });
    expect(client.agentIds.every((id) => id === 'agent-1')).toBe(true);
  });

  it('refuses a foreign handle and an unknown handle as tool errors', async () => {
    const started = await requireTool(registry, 'shell.start').execute({ command: 'cat' }, toolCtx(store));
    expect(client.processes.get(String(started.details?.handle))?.scope).toBe('agent-1');
    client.processes.set('p_00000000000f', { scope: 'agent-9', output: '', state: 'running', exitCode: null });
    const foreign = await requireTool(registry, 'shell.poll').execute({ handle: 'p_00000000000f' }, toolCtx(store));
    expect(foreign.isError).toBe(true);
    expect(foreign.details).toMatchObject({ code: 'not_allowed' });
    const unknown = await requireTool(registry, 'shell.poll').execute({ handle: 'p_00000000000e' }, toolCtx(store));
    expect(unknown.isError).toBe(true);
    expect(unknown.details).toMatchObject({ code: 'failed' });
  });
});

describe('sandbox process seam over a real sh', () => {
  let root: string;
  let processes: ReturnType<typeof createSandboxProcesses>;
  // Every process a test starts is stopped in teardown, so a failing assertion never leaves a sleeper behind.
  let live: string[];
  const start = async (input: ProcessStartInput, sig: AbortSignal) => {
    const snapshot = await processes.start('agent-1', input, sig);
    live.push(snapshot.handle);
    return snapshot;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vomu-proc-'));
    processes = createSandboxProcesses(new LocalRuntime(root));
    live = [];
  });

  afterEach(async () => {
    for (const handle of live.splice(0)) await processes.stop('agent-1', { handle }, signal()).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('starts a detached process, feeds stdin, polls its output and stops it', async () => {
    const started = await start({ command: 'cat' }, signal());
    expect(started.state).toBe('running');
    expect(started.pid).toBeGreaterThan(0);
    const written = await processes.write('agent-1', { handle: started.handle, data: 'hello world\n' }, signal());
    expect(written.bytes).toBe(12);
    await waitFor(async () => (await processes.read('agent-1', { handle: started.handle }, signal())).output.includes('hello world'));
    const poll = await processes.read('agent-1', { handle: started.handle }, signal());
    expect(poll.output).toContain('hello world');
    expect(poll.state).toBe('running');
    expect(await processes.stop('agent-1', { handle: started.handle }, signal())).toMatchObject({ state: 'stopped', exitCode: 143 });
    expect((await processes.read('agent-1', { handle: started.handle }, signal())).state).toBe('stopped');
  });

  it('fails visibly when the working directory does not exist instead of running elsewhere', async () => {
    await expect(start({ command: 'cat', cwd: join(root, 'missing') }, signal())).rejects.toThrow(/working directory/);
  });

  it('records the real exit code of a process that finishes on its own', async () => {
    const started = await start({ command: 'printf hi; false' }, signal());
    await waitFor(async () => (await processes.read('agent-1', { handle: started.handle }, signal())).state === 'exited');
    const read = await processes.read('agent-1', { handle: started.handle }, signal());
    expect(read.state).toBe('exited');
    expect(read.exitCode).toBe(1);
    expect(read.output).toContain('hi');
  });

  it('isolates handles per agent and reports unknown or malformed handles', async () => {
    const started = await start({ command: 'cat' }, signal());
    await expect(processes.read('agent-2', { handle: started.handle }, signal())).rejects.toThrow(/not known/);
    await expect(processes.write('agent-2', { handle: started.handle, data: 'x' }, signal())).rejects.toThrow(/not known/);
    await expect(processes.read('agent-1', { handle: 'p_ffffffffffff' }, signal())).rejects.toThrow(/not known/);
    await expect(processes.read('agent-1', { handle: '../../etc/passwd' }, signal())).rejects.toThrow(/handle/);
    await expect(processes.stop('agent-1', { handle: started.handle }, signal())).resolves.toMatchObject({ state: 'stopped' });
  });

  it('keeps concurrent polls with different cursors from mixing', async () => {
    const started = await start({ command: 'sh -c "printf abcdefghij"' }, signal());
    await waitFor(async () => (await processes.read('agent-1', { handle: started.handle }, signal())).state === 'exited');
    const [first, second] = await Promise.all([
      processes.read('agent-1', { handle: started.handle, cursor: 0, maxBytes: 4 }, signal()),
      processes.read('agent-1', { handle: started.handle, cursor: 6, maxBytes: 4 }, signal()),
    ]);
    expect(first.output).toBe('abcd');
    expect(second.output).toBe('ghij');
    expect([first.cursor, second.cursor]).toEqual([4, 10]);
  });

  it('makes progress and stays lossless when maxBytes is below one character', async () => {
    const text = '中'.repeat(20);
    const started = await start({ command: 'printf ' + text }, signal());
    await waitFor(async () => (await processes.read('agent-1', { handle: started.handle }, signal())).state === 'exited');
    let collected = '';
    let cursor = 0;
    for (let page = 0; page < 40; page += 1) {
      const read = await processes.read('agent-1', { handle: started.handle, cursor, maxBytes: 1 }, signal());
      collected += read.output;
      if (!read.truncated) break;
      expect(read.cursor).toBeGreaterThan(cursor);
      cursor = read.cursor;
    }
    expect(collected).toBe(text);
  });

  it('reports a killed process as expired rather than claiming a stop, and never prunes a live handle', async () => {
    const started = await start({ command: 'sleep 3' }, signal());
    await new LocalRuntime(root).run('kill -KILL ' + String(started.pid), { timeoutMs: 5_000, signal: signal() });
    await waitFor(async () => (await processes.read('agent-1', { handle: started.handle }, signal())).state === 'expired');
    expect(await processes.stop('agent-1', { handle: started.handle }, signal())).toMatchObject({ state: 'expired', exitCode: null });
    const live = await start({ command: 'cat' }, signal());
    await processes.cleanup('agent-1', signal());
    expect((await processes.read('agent-1', { handle: live.handle }, signal())).state).toBe('running');
  });

  it('ends a process at its timeoutMs limit with exit 124', async () => {
    const started = await start({ command: 'sleep 30', timeoutMs: 1000 }, signal());
    await waitFor(async () => (await processes.read('agent-1', { handle: started.handle }, signal())).state === 'exited');
    expect(await processes.read('agent-1', { handle: started.handle }, signal())).toMatchObject({ state: 'exited', exitCode: 124 });
  });

  it('fails loudly, and does not claim expired, when the runtime working directory is gone', async () => {
    const started = await start({ command: 'cat' }, signal());
    rmSync(root, { recursive: true, force: true });
    try {
      // The runtime cannot run from a missing directory: that is an error, never a silent "expired" for a live process.
      await expect(processes.stop('agent-1', { handle: started.handle }, signal())).rejects.toThrow(/no status/);
    } finally {
      // Stop it through a runtime whose directory exists, so the cat is not left running.
      await createSandboxProcesses(new LocalRuntime(tmpdir())).stop('agent-1', { handle: started.handle }, signal()).catch(() => undefined);
    }
  });
});
