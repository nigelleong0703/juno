/**
 * Sandbox-side async process supervision, provider-agnostic.
 *
 * Every verb runs inside the bound computer through the narrow `SandboxRuntime` (a POSIX shell plus
 * file read/write), so E2B and the local Docker provider share one implementation and a handle stays
 * addressable across separate computerd calls. The handle scope is the requesting agent: the shell
 * protocol re-checks a per-handle scope file, and a handle is validated before use, so one agent can
 * never read, write or stop another agent's process. No PTY is allocated and no host process is
 * spawned. Each program leads its own process group (setsid, else perl setpgrp), and stop signals that
 * whole group (TERM, then KILL after 2s), so the wrapper's children die with it, even on macOS. The
 * signal is sent only after the process is proven to still be this handle's (command-line identity),
 * so a recycled pid is refused rather than killed. Only a runtime with neither setsid nor perl falls
 * back to signalling the recorded pid alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CommandResult, SandboxRuntime } from './runtime.js';
import { shq } from './screen-boot.js';
import { cleanupProgram, readProgram, startProgram, stopProgram, writeProgram } from './processPrograms.js';
import { aborted, failed, notAllowed } from './errors.js';
import { emptySlice, readStream } from './processStreams.js';
import type {
  ProcessOutput,
  ProcessReadInput,
  ProcessSnapshot,
  ProcessStartInput,
  ProcessState,
  ProcessStopInput,
  ProcessStopResult,
  ProcessWriteInput,
  ProcessWriteResult,
} from './types.js';

export const PROCESS_ROOT = '/tmp/vomu-proc';
export const MAX_PROCESS_READ_BYTES = 32 * 1024;
/** A window smaller than one code point could never advance the cursor, so 4 bytes is the floor. */
const MIN_PROCESS_READ_BYTES = 4;
const START_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 20_000;
const HANDLE_PATTERN = /^p_[0-9a-f]{12}$/;

export interface SandboxProcesses {
  start(agentId: string, input: ProcessStartInput, signal: AbortSignal): Promise<ProcessSnapshot>;
  read(agentId: string, input: ProcessReadInput, signal: AbortSignal): Promise<ProcessOutput>;
  write(agentId: string, input: ProcessWriteInput, signal: AbortSignal): Promise<ProcessWriteResult>;
  stop(agentId: string, input: ProcessStopInput, signal: AbortSignal): Promise<ProcessStopResult>;
  /** Remove scratch directories for processes that finished more than the TTL ago. */
  cleanup(agentId: string, signal: AbortSignal): Promise<void>;
}

export function createSandboxProcesses(runtime: SandboxRuntime, root: string = PROCESS_ROOT): SandboxProcesses {
  const scopeDir = (agentId: string) => root + '/' + createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 16);
  const handleDir = (agentId: string, handle: string) => scopeDir(agentId) + '/' + handle;
  return {
    async start(agentId, input, signal) {
      const handle = 'p_' + randomUUID().replace(/-/g, '').slice(0, 12);
      const dir = handleDir(agentId, handle);
      let result;
      try {
        result = await run(runtime, startProgram(dir, agentId, input), START_TIMEOUT_MS, signal);
      } catch (error) {
        // The launch may already have happened; never leave a running process or scratch behind.
        await discard(runtime, dir, agentId);
        throw error;
      }
      const stdout = result.stdout.trim();
      if (stdout === 'NOCWD') {
        await discard(runtime, dir, agentId);
        throw failed('the process working directory does not exist in the sandbox');
      }
      const [pidText, startedAt] = stdout.split('\t');
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 0) {
        await discard(runtime, dir, agentId);
        throw failed('the sandbox did not start the process');
      }
      return { handle, pid, state: 'running', exitCode: null, startedAt: startedAt ?? '' };
    },

    async read(agentId, input, signal) {
      const dir = handleDir(agentId, requireHandle(input.handle));
      const cursor = Math.max(0, Math.trunc(input.cursor ?? 0));
      const stderrCursor = Math.max(0, Math.trunc(input.stderrCursor ?? 0));
      const maxBytes = Math.max(MIN_PROCESS_READ_BYTES, Math.min(Math.trunc(input.maxBytes ?? MAX_PROCESS_READ_BYTES), MAX_PROCESS_READ_BYTES));
      // Per-call slice paths: two concurrent polls (different cursors) cannot overwrite each other.
      const token = randomUUID().replace(/-/g, '');
      const outSlice = dir + '/out.' + token;
      const errSlice = dir + '/err.' + token;
      const result = await run(runtime, readProgram(dir, agentId, cursor, stderrCursor, maxBytes, outSlice, errSlice), READ_TIMEOUT_MS, signal);
      const meta = parseMeta(requireStatus(result, input.handle), input.handle);
      const out = meta.totalBytes > cursor ? await readStream(runtime, outSlice, cursor, maxBytes, meta.totalBytes) : emptySlice(cursor);
      const err = meta.stderrTotalBytes > stderrCursor ? await readStream(runtime, errSlice, stderrCursor, maxBytes, meta.stderrTotalBytes) : emptySlice(stderrCursor);
      return {
        handle: input.handle,
        state: meta.state,
        exitCode: meta.exitCode,
        output: out.text,
        stderr: err.text,
        cursor: out.cursor,
        stderrCursor: err.cursor,
        totalBytes: meta.totalBytes,
        stderrTotalBytes: meta.stderrTotalBytes,
        truncated: out.truncated,
        stderrTruncated: err.truncated,
      };
    },

    async write(agentId, input, signal) {
      const dir = handleDir(agentId, requireHandle(input.handle));
      const result = await run(runtime, writeProgram(dir, agentId, input.data), WRITE_TIMEOUT_MS, signal);
      const status = result.stdout.trim();
      if (status === 'UNKNOWN') throw failed(unknownMessage(input.handle));
      if (status === 'DENIED') throw notAllowed(deniedMessage(input.handle));
      if (status !== 'OK') throw failed('the sandbox refused the input: this process has no writable stdin');
      return { handle: input.handle, bytes: Buffer.byteLength(input.data, 'utf8') };
    },

    async stop(agentId, input, signal) {
      const dir = handleDir(agentId, requireHandle(input.handle));
      const result = await run(runtime, stopProgram(dir, agentId), STOP_TIMEOUT_MS, signal);
      const line = requireStatus(result, input.handle).trim();
      if (line === 'UNKNOWN') throw failed(unknownMessage(input.handle));
      if (line === 'DENIED') throw notAllowed(deniedMessage(input.handle));
      const [state, code] = line.split('\t');
      return { handle: input.handle, state: parseState(state), exitCode: code === undefined || code === '-' ? null : Number(code) };
    },

    async cleanup(agentId, signal) {
      // Best effort: cleanup never fails a start and never touches a running handle (the program
      // removes only directories that carry an exit/stopped marker older than the TTL).
      await run(runtime, cleanupProgram(scopeDir(agentId)), READ_TIMEOUT_MS, signal).catch(() => undefined);
    },
  };
}

/** A handle is data from the model; validate it before it becomes a path segment. */
function requireHandle(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) throw notAllowed('a process handle is p_ followed by 12 hex digits');
  return handle;
}

function parseState(value: string | undefined): ProcessState {
  if (value === 'running' || value === 'exited' || value === 'stopped' || value === 'expired') return value;
  throw failed('the sandbox returned an unknown process state: ' + String(value));
}

/**
 * The status line of a process program. Empty output means the program never ran (for example, the runtime's
 * working directory is gone), so the process state is unknown: that is an error, never a silent "expired".
 */
function requireStatus(result: CommandResult, handle: string): string {
  if (result.stdout.trim() !== '') return result.stdout;
  const detail = result.stderr.trim();
  throw failed('the sandbox gave no status for process ' + handle + ' (exit ' + String(result.exitCode) + (detail === '' ? '' : ': ' + detail.slice(0, 200)) + '); its state is unknown');
}

function parseMeta(stdout: string, handle: string): { state: ProcessState; exitCode: number | null; totalBytes: number; stderrTotalBytes: number } {
  const line = stdout.trim();
  if (line === 'UNKNOWN') throw failed(unknownMessage(handle));
  if (line === 'DENIED') throw notAllowed(deniedMessage(handle));
  const [state, code, total, errTotal] = line.split('\t');
  return {
    state: parseState(state),
    exitCode: code === undefined || code === '-' ? null : Number(code),
    totalBytes: Number(total) || 0,
    stderrTotalBytes: Number(errTotal) || 0,
  };
}


/** Best effort: stop a handle we just created and remove its scratch dir after a failed/aborted start. */
async function discard(runtime: SandboxRuntime, dir: string, agentId: string): Promise<void> {
  const signal = new AbortController().signal;
  await runtime.run(stopProgram(dir, agentId), { timeoutMs: 5_000, signal }).catch(() => undefined);
  await runtime.run('rm -rf ' + shq(dir), { timeoutMs: 5_000, signal }).catch(() => undefined);
}

async function run(runtime: SandboxRuntime, program: string, timeoutMs: number, signal: AbortSignal) {
  try {
    return await runtime.run(program, { timeoutMs, signal });
  } catch (error) {
    if (signal.aborted) throw aborted('the process action was cancelled');
    throw failed('the sandbox could not run the process command: ' + (error instanceof Error ? error.message : String(error)));
  }
}

function unknownMessage(handle: string): string {
  return 'process ' + handle + ' is not known on this computer (it expired or never existed)';
}

function deniedMessage(handle: string): string {
  return 'process ' + handle + ' belongs to another agent';
}
