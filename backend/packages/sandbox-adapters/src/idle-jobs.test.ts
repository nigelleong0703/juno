import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import type { LifecycleDriver, MachineState } from './driver.js';
import type { LinkConnection, LinkHub } from './link-hub.js';
import { createLinkedProvider } from './linked-provider.js';
import { createSandboxProcesses, hasRunningProcess } from './processes.js';
import { BACKGROUND_JOB_KEEP_AWAKE_MINUTES } from './processPrograms.js';
import type { CommandResult, SandboxRuntime } from './runtime.js';

const signal = () => new AbortController().signal;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A runtime that runs the process programs in this host's own shell (the same trick link.test.ts uses for the daemon). */
const hostRuntime: SandboxRuntime = {
  run: (command) => new Promise<CommandResult>((resolve) => {
    execFile('/bin/sh', ['-c', command], (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1 }));
  }),
  readText: async () => '',
  readBytes: async () => new Uint8Array(),
  writeText: async () => undefined,
  writeBytes: async () => undefined,
};

describe('background jobs keep a computer awake', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('sees a shell.start process while it lives, and not after it ended or was stopped', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'idle-jobs-')));
    dirs.push(root);
    const processes = createSandboxProcesses(hostRuntime, root);
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(false);

    const long = await processes.start('agt-a', { command: 'sleep 30' }, signal());
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(true);
    await processes.stop('agt-a', { handle: long.handle }, signal());
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(false);

    await processes.start('agt-b', { command: 'sleep 0.3' }, signal());
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(true);
    await sleep(900);
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(false);
  });

  it('stops counting a job that started more than the cap ago, and still counts one just inside it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'idle-jobs-cap-')));
    dirs.push(root);
    const processes = createSandboxProcesses(hostRuntime, root);
    const job = await processes.start('agt-a', { command: 'sleep 30' }, signal());
    const pidFile = join(root, readdirSync(root)[0] ?? '', job.handle, 'pid');
    // `touch -t` sets the start time the cap counts from: the pid file is written once, when the job starts.
    const startedAgo = (minutes: number): void => {
      const at = new Date(Date.now() - minutes * 60_000);
      const pad = (n: number): string => String(n).padStart(2, '0');
      execFileSync('touch', ['-t', `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`, pidFile]);
    };
    startedAgo(BACKGROUND_JOB_KEEP_AWAKE_MINUTES - 10);
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(true);
    startedAgo(BACKGROUND_JOB_KEEP_AWAKE_MINUTES + 10);
    expect(await hasRunningProcess(hostRuntime, signal(), root)).toBe(false);
    // Frozen, not killed: the process itself is still there.
    expect((await processes.read('agt-a', { handle: job.handle }, signal())).state).toBe('running');
    await processes.stop('agt-a', { handle: job.handle }, signal());
  });

  it('does not pause while a job runs, however many idle windows pass, and pauses one window after the last job ends', async () => {
    vi.useFakeTimers();
    let jobs = true;
    let state: MachineState = 'running';
    const suspended: string[] = [];
    const link = {
      id: 'link-1', bootId: 'boot-1', open: true,
      exec: async () => ({ stdout: jobs ? 'RUNNING\n' : 'IDLE\n', stderr: '', exitCode: 0 }),
      writeFile: async () => undefined,
      health: async () => ({}),
    } as unknown as LinkConnection;
    const hub = { tokenFor: () => 't', waitFor: async () => link, get: () => link, drop: () => undefined } as unknown as LinkHub;
    const driver: LifecycleDriver = {
      kind: 'fake',
      create: async () => ({ sandboxId: 'sbx-1', template: 'test' }),
      status: async () => state,
      start: async () => { state = 'running'; },
      stop: async () => { state = 'stopped'; },
      destroy: async () => undefined,
      suspend: async (binding: E2bBinding) => { suspended.push(binding.sandboxId); state = 'suspended'; },
    };
    const provider = createLinkedProvider({ driver, hub, linkUrl: 'ws://x', ownerId: 'owner', image: 'img' });
    const window = 60_000;
    await provider.create({ template: 'img', resolution: '1280x800', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 1 }, signal());

    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(window);
    expect(suspended).toEqual([]);
    expect(state).toBe('running');

    // The job ends: the next window finds no job and pauses.
    jobs = false;
    await vi.advanceTimersByTimeAsync(window);
    expect(suspended).toEqual(['sbx-1']);
    provider.dispose();
  });
});
