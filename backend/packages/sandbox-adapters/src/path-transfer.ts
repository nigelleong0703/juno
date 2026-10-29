/**
 * Moving a file or a folder out of one of an agent's computers and into the other (`computer_copy`). Each computer gives a
 * `TransferSide`; computerd reads from one and writes to the other, so the bytes never pass through the model.
 *
 *  - A file travels as itself. On the owner's Mac that is the daemon's own file calls (they refuse a path outside the shared
 *    folders, symlinks included); in the sandbox it is staged through the agent's own Linux user, so the agent can only copy
 *    what it could read or write itself.
 *  - A folder travels as a tar archive built and unpacked by `tar` with the folder's parent as the working directory (the Mac
 *    daemon checks that directory), so a name from the model is never part of a path outside it.
 *
 * Size is capped by the caller on what comes back.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { failed } from './errors.js';
import type { SandboxRuntime } from './runtime.js';
import { shq } from './shq.js';

export type PathKind = 'file' | 'folder';

export interface TransferSide {
  /** What `path` is, or `missing`. */
  kindOf(path: string, signal: AbortSignal): Promise<PathKind | 'missing'>;
  readFile(path: string, signal: AbortSignal): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** The folder as a tar archive. */
  readFolder(path: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Unpack a tar archive of one folder so that it becomes `path` (an existing folder there is replaced). */
  writeFolder(path: string, tar: Uint8Array, signal: AbortSignal): Promise<void>;
}

const TIMEOUT_MS = 120_000;

/** The shell side shared by both computers: what is needed to run a command in a directory and to move stage files. */
interface Shell {
  run(command: string, cwd: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** A unique stage path, readable and writable by the root-side file calls (and by the shell user for the file's life). */
  stagePath(): string;
  readStage(path: string, signal: AbortSignal): Promise<Uint8Array>;
  writeStage(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  removeStage(path: string, signal?: AbortSignal): Promise<void>;
}

const nameOf = (path: string): string => posix.basename(path.replace(/\/+$/, '')) || path;
const parentOf = (path: string): string => posix.dirname(path.replace(/\/+$/, '')) || '/';

async function must(result: Promise<{ stdout: string; stderr: string; exitCode: number }>, what: string): Promise<string> {
  const done = await result;
  if (done.exitCode !== 0) throw failed(`could not ${what}: ${(done.stderr || done.stdout).trim().slice(0, 300)}`);
  return done.stdout;
}

/** The shell-based half (kind, folders) over a `Shell`. */
function shellSide(shell: Shell): Pick<TransferSide, 'kindOf' | 'readFolder' | 'writeFolder'> {
  return {
    async kindOf(path, signal) {
      const name = shq('./' + nameOf(path));
      const out = await must(shell.run(`if [ -d ${name} ]; then echo folder; elif [ -f ${name} ]; then echo file; else echo missing; fi`, parentOf(path), signal), `look at ${path}`);
      const kind = out.trim();
      return kind === 'folder' || kind === 'file' ? kind : 'missing';
    },
    async readFolder(path, signal) {
      const stage = shell.stagePath();
      try {
        await must(shell.run(`mkdir -p ${shq(posix.dirname(stage))} && tar -cf ${shq(stage)} ${shq('./' + nameOf(path))}`, parentOf(path), signal), `pack ${path}`);
        return await shell.readStage(stage, signal);
      } finally {
        await shell.removeStage(stage, signal).catch(() => undefined);
      }
    },
    async writeFolder(path, tar, signal) {
      const stage = shell.stagePath();
      const name = nameOf(path);
      const work = `.juno-unpack-${randomUUID().slice(0, 8)}`;
      try {
        await shell.writeStage(stage, tar, signal);
        // Unpack beside the target, then swap it in: a failed unpack leaves the old folder untouched.
        await must(
          shell.run(
            [`mkdir ${shq(work)}`, `tar -xf ${shq(stage)} -C ${shq(work)}`, `[ -e ${shq(work + '/' + name)} ] || { rm -rf ${shq(work)}; echo 'the archive does not hold the folder' >&2; exit 3; }`, `rm -rf ${shq('./' + name)}`, `mv ${shq(work + '/' + name)} ${shq('./' + name)}`, `rm -rf ${shq(work)}`].join(' && '),
            parentOf(path), signal,
          ),
          `unpack into ${path}`,
        );
      } finally {
        await shell.removeStage(stage, signal).catch(() => undefined);
      }
    },
  };
}

/**
 * The agent's sandbox: commands run as the agent's Linux user (`agent`), the stage is a file in /tmp that root reads and writes
 * with the link's file calls.
 */
export function createSandboxSide(root: SandboxRuntime, agent: SandboxRuntime): TransferSide {
  const shell: Shell = {
    run: (command, cwd, signal) => agent.run(command, { cwd, timeoutMs: TIMEOUT_MS, signal }),
    stagePath: () => `/tmp/juno-copy-${randomUUID()}`,
    readStage: (path) => root.readBytes(path),
    async writeStage(path, bytes) {
      await root.writeBytes(path, bytes);
      // Root wrote it; the agent's user has to be able to read it to place it.
      await root.run(`chmod 0644 ${shq(path)}`, { timeoutMs: 30_000 });
    },
    async removeStage(path) {
      await root.run(`rm -f ${shq(path)}`, { timeoutMs: 30_000 });
    },
  };
  return {
    ...shellSide(shell),
    async readFile(path, signal) {
      const stage = shell.stagePath();
      try {
        await must(shell.run(`cp -- ${shq('./' + nameOf(path))} ${shq(stage)}`, parentOf(path), signal), `read ${path}`);
        return await shell.readStage(stage, signal);
      } finally {
        await shell.removeStage(stage).catch(() => undefined);
      }
    },
    async writeFile(path, bytes, signal) {
      const stage = shell.stagePath();
      try {
        await shell.writeStage(stage, bytes, signal);
        await must(shell.run(`mkdir -p -- ${shq(parentOf(path))} && cp -- ${shq(stage)} ${shq(path)}`, '/', signal), `write ${path}`);
      } finally {
        await shell.removeStage(stage).catch(() => undefined);
      }
    },
  };
}

/**
 * The owner's Mac: `link` is the link runtime (its file calls refuse anything outside the shared folders), `folder` the shared
 * folder; stage files live in `<folder>/.juno/copy`.
 */
export function createMacSide(link: SandboxRuntime, folder: string): TransferSide {
  const stageDir = `${folder}/.juno/copy`;
  const shell: Shell = {
    run: (command, cwd, signal) => link.run(command, { cwd, timeoutMs: TIMEOUT_MS, signal }),
    stagePath: () => `${stageDir}/${randomUUID()}.tar`,
    readStage: (path) => link.readBytes(path),
    writeStage: (path, bytes) => link.writeBytes(path, bytes),
    async removeStage(path) {
      await link.run(`rm -f ${shq(path)}`, { cwd: folder, timeoutMs: 30_000 });
    },
  };
  return {
    ...shellSide(shell),
    readFile: (path) => link.readBytes(path),
    writeFile: (path, bytes) => link.writeBytes(path, bytes),
  };
}
