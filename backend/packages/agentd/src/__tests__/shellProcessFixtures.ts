/** Scaffolding for the shell-process tests: a real local sh runtime and an in-memory process client. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, RuntimeOptions, SandboxProcesses, SandboxRuntime } from '@agent-desktop/sandbox-adapters';
import type { ProcessOutput, ProcessReadInput, ProcessSnapshot, ProcessStartInput, ProcessState, ProcessStopInput, ProcessStopResult, ProcessWriteInput, ProcessWriteResult } from 'juno-agent/modules/tools/index';
import { ComputerError } from 'juno-agent/modules/tools/index';
import { SandboxFiles } from 'juno-agent/modules/tools/__tests__/codingFixtures';
import { createSandboxProcesses } from '@agent-desktop/sandbox-adapters';

/** Runs the generated shell program for real under `sh`, like the local Docker runtime does. */
export class LocalRuntime implements SandboxRuntime {
  constructor(readonly root: string) {}

  async run(command: string, options?: RuntimeOptions): Promise<CommandResult> {
    const result = spawnSync('sh', ['-c', command], { cwd: options?.cwd ?? this.root, encoding: 'utf8', timeout: options?.timeoutMs ?? 10_000 });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
  }

  async readText(path: string): Promise<string> { return readFileSync(path, 'utf8'); }
  async readBytes(path: string): Promise<Uint8Array> { return readFileSync(path); }
  async writeText(path: string, content: string): Promise<void> { writeFileSync(path, content); }
  async writeBytes(path: string, content: Uint8Array): Promise<void> { writeFileSync(path, content); }
}

interface Entry { scope: string; output: string; state: ProcessState; exitCode: number | null; }

/** A client that routes every process verb to the CALLING agent's own sandbox (distinct roots). */
export class AgentScopedProcessClient extends SandboxFiles {
  readonly calls: Array<{ agentId: string; action: string }> = [];
  private readonly perAgent = new Map<string, { sandbox: SandboxProcesses; root: string }>();

  private sandboxFor(agentId: string): { sandbox: SandboxProcesses; root: string } {
    const existing = this.perAgent.get(agentId);
    if (existing !== undefined) return existing;
    const root = mkdtempSync(join(tmpdir(), 'juno-agent-'));
    const created = { sandbox: createSandboxProcesses(new LocalRuntime(root)), root };
    this.perAgent.set(agentId, created);
    return created;
  }

  /** How many process calls were made FOR this agent (a foreign agent's computer must stay at 0). */
  callsFor(agentId: string): number {
    return this.calls.filter((call) => call.agentId === agentId).length;
  }

  roots(): string[] {
    return [...this.perAgent.values()].map((entry) => entry.root);
  }

  async startProcess(agentId: string, input: ProcessStartInput): Promise<ProcessSnapshot> {
    this.calls.push({ agentId, action: 'start' });
    return this.sandboxFor(agentId).sandbox.start(agentId, input, new AbortController().signal);
  }

  async readProcess(agentId: string, input: ProcessReadInput): Promise<ProcessOutput> {
    this.calls.push({ agentId, action: 'read' });
    return this.sandboxFor(agentId).sandbox.read(agentId, input, new AbortController().signal);
  }

  async writeProcess(agentId: string, input: ProcessWriteInput): Promise<ProcessWriteResult> {
    this.calls.push({ agentId, action: 'write' });
    return this.sandboxFor(agentId).sandbox.write(agentId, input, new AbortController().signal);
  }

  async stopProcess(agentId: string, input: ProcessStopInput): Promise<ProcessStopResult> {
    this.calls.push({ agentId, action: 'stop' });
    return this.sandboxFor(agentId).sandbox.stop(agentId, input, new AbortController().signal);
  }
}

/** A client whose process verbs run for real through the sandbox seam on a local POSIX sh. */
export class PosixProcessClient extends SandboxFiles {
  private readonly processes = createSandboxProcesses(new LocalRuntime('.'));

  async startProcess(agentId: string, input: ProcessStartInput): Promise<ProcessSnapshot> {
    this.agentIds.push(agentId);
    return this.processes.start(agentId, input, new AbortController().signal);
  }

  async readProcess(agentId: string, input: ProcessReadInput): Promise<ProcessOutput> {
    this.agentIds.push(agentId);
    return this.processes.read(agentId, input, new AbortController().signal);
  }

  async writeProcess(agentId: string, input: ProcessWriteInput): Promise<ProcessWriteResult> {
    this.agentIds.push(agentId);
    return this.processes.write(agentId, input, new AbortController().signal);
  }

  async stopProcess(agentId: string, input: ProcessStopInput): Promise<ProcessStopResult> {
    this.agentIds.push(agentId);
    return this.processes.stop(agentId, input, new AbortController().signal);
  }
}

/** An in-memory process client for the tool tests; the seam tests use the real runtime above. */
export class ProcessSandboxClient extends SandboxFiles {
  readonly processes = new Map<string, Entry>();
  private seq = 0;

  private owned(agentId: string, handle: string): Entry {
    const entry = this.processes.get(handle);
    if (!entry) throw new ComputerError('failed', 'process ' + handle + ' is not known');
    if (entry.scope !== agentId) throw new ComputerError('not_allowed', 'process ' + handle + ' belongs to another agent');
    return entry;
  }

  async startProcess(agentId: string, input: ProcessStartInput): Promise<ProcessSnapshot> {
    this.agentIds.push(agentId);
    this.seq += 1;
    const handle = 'p_' + String(this.seq).padStart(12, '0');
    this.processes.set(handle, { scope: agentId, output: 'started: ' + input.command + '\n', state: 'running', exitCode: null });
    return { handle, pid: 900 + this.seq, state: 'running', exitCode: null, startedAt: '2026-10-08T00:00:00.000Z' };
  }

  async readProcess(agentId: string, input: ProcessReadInput): Promise<ProcessOutput> {
    this.agentIds.push(agentId);
    const entry = this.owned(agentId, input.handle);
    const cursor = Math.max(0, Math.trunc(input.cursor ?? 0));
    const maxBytes = Math.max(1, Math.trunc(input.maxBytes ?? 32 * 1024));
    const bytes = Buffer.from(entry.output, 'utf8');
    const slice = bytes.subarray(cursor, cursor + maxBytes);
    const next = cursor + slice.length;
    return {
      handle: input.handle,
      state: entry.state,
      exitCode: entry.exitCode,
      output: slice.toString('utf8'),
      stderr: '',
      cursor: next,
      stderrCursor: 0,
      totalBytes: bytes.length,
      stderrTotalBytes: 0,
      truncated: next < bytes.length,
      stderrTruncated: false,
    };
  }

  async writeProcess(agentId: string, input: ProcessWriteInput): Promise<ProcessWriteResult> {
    this.agentIds.push(agentId);
    const entry = this.owned(agentId, input.handle);
    entry.output += input.data;
    return { handle: input.handle, bytes: Buffer.byteLength(input.data, 'utf8') };
  }

  async stopProcess(agentId: string, input: ProcessStopInput): Promise<ProcessStopResult> {
    this.agentIds.push(agentId);
    const entry = this.owned(agentId, input.handle);
    if (entry.state === 'running') { entry.state = 'stopped'; entry.exitCode = 143; }
    return { handle: input.handle, state: entry.state, exitCode: entry.exitCode };
  }
}

/** Records the HTTP call the computerd client makes and replays one canned JSON body. */
export class RecordingFetch {
  readonly calls: Array<{ url: string; method: string; agentId: string | null; body: unknown }> = [];
  response: unknown = {};

  asFetch(): typeof fetch {
    type Args = Parameters<typeof fetch>;
    const handler = async (input: Args[0], init?: Args[1]): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      this.calls.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        agentId: headers['x-agent-id'] ?? null,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(this.response), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return handler as unknown as typeof fetch;
  }
}
