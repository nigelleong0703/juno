/**
 * An in-memory process double for computerd's route/unit tests. It mirrors the observable contract of
 * the real sandbox seam (handle scope, cursor, state/exit) without a sandbox, exactly as the rest of
 * the fake provider does; production always runs processPrograms.ts against the bound computer.
 */
import { randomUUID } from 'node:crypto';
import { failed, notAllowed } from './errors.js';
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

export interface FakeProcesses {
  start(agentId: string, input: ProcessStartInput): ProcessSnapshot;
  read(agentId: string, input: ProcessReadInput): ProcessOutput;
  write(agentId: string, input: ProcessWriteInput): ProcessWriteResult;
  stop(agentId: string, input: ProcessStopInput): ProcessStopResult;
  /** handle -> owning agent, so a test can assert the scope fence. */
  readonly scopes: Map<string, string>;
  /** Test hook: append raw stderr to one handle (the real seam captures the process's stderr). */
  appendStderr(handle: string, text: string): void;
}

/** Test convention: `fake:exit <code> after <ms>` reads as exited with that code once the time has passed. */
const SCRIPTED_EXIT = /^fake:exit (\d+) after (\d+)$/;

function settleScriptedExit(entry: Entry): void {
  if (entry.state !== 'running') return;
  const match = SCRIPTED_EXIT.exec(entry.command);
  if (match === null) return;
  if (Date.now() - Date.parse(entry.startedAt) < Number(match[2])) return;
  entry.state = 'exited';
  entry.exitCode = Number(match[1]);
  entry.output += 'exited with code ' + String(entry.exitCode) + '\n';
}

interface Entry {
  command: string;
  scope: string;
  output: string;
  stderr: string;
  state: ProcessState;
  exitCode: number | null;
  pid: number;
  startedAt: string;
}

export function createFakeProcesses(): FakeProcesses {
  const entries = new Map<string, Entry>();
  const scopes = new Map<string, string>();
  let nextPid = 1000;

  const owned = (handle: string, agentId: string): Entry => {
    const entry = entries.get(handle);
    if (!entry) throw failed('process ' + handle + ' is not known on this computer');
    if (entry.scope !== agentId) throw notAllowed('process ' + handle + ' belongs to another agent');
    return entry;
  };

  return {
    scopes,
    start(agentId, input) {
      const handle = 'p_' + randomUUID().replace(/-/g, '').slice(0, 12);
      nextPid += 1;
      const entry: Entry = { command: input.command, scope: agentId, output: 'fake process: ' + input.command + '\n', stderr: '', state: 'running', exitCode: null, pid: nextPid, startedAt: new Date().toISOString() };
      entries.set(handle, entry);
      scopes.set(handle, agentId);
      return { handle, pid: entry.pid, state: 'running', exitCode: null, startedAt: entry.startedAt };
    },
    read(agentId, input) {
      const entry = owned(input.handle, agentId);
      settleScriptedExit(entry);
      const cursor = Math.max(0, Math.trunc(input.cursor ?? 0));
      const stderrCursor = Math.max(0, Math.trunc(input.stderrCursor ?? 0));
      const maxBytes = Math.max(1, Math.trunc(input.maxBytes ?? 32 * 1024));
      const out = Buffer.from(entry.output, 'utf8');
      const err = Buffer.from(entry.stderr, 'utf8');
      const outSlice = out.subarray(cursor, cursor + maxBytes);
      const errSlice = err.subarray(stderrCursor, stderrCursor + maxBytes);
      const next = cursor + outSlice.length;
      const nextErr = stderrCursor + errSlice.length;
      return {
        handle: input.handle,
        state: entry.state,
        exitCode: entry.exitCode,
        output: outSlice.toString('utf8'),
        stderr: errSlice.toString('utf8'),
        cursor: next,
        stderrCursor: nextErr,
        totalBytes: out.length,
        stderrTotalBytes: err.length,
        truncated: next < out.length,
        stderrTruncated: nextErr < err.length,
      };
    },
    write(agentId, input) {
      const entry = owned(input.handle, agentId);
      entry.output += input.data;
      return { handle: input.handle, bytes: Buffer.byteLength(input.data, 'utf8') };
    },
    stop(agentId, input) {
      const entry = owned(input.handle, agentId);
      if (entry.state === 'running') {
        entry.state = 'stopped';
        entry.exitCode = 143;
      }
      return { handle: input.handle, state: entry.state, exitCode: entry.exitCode };
    },
    appendStderr(handle, text) {
      const entry = entries.get(handle);
      if (entry !== undefined) entry.stderr += text;
    },
  };
}
