/** Root scripts that change the computer's users, mounts or network run one at a time (BACKEND §7.9). */
import { failed } from './errors.js';
import type { SandboxRuntime } from './runtime.js';
import { shq } from './shq.js';

const LOCK = '/tmp/.juno-isolate.lock';
export const SCRIPT_TIMEOUT_MS = 300_000;

/** Run a script as root under the isolation lock (two prepares never interleave). */
export async function runLocked(root: SandboxRuntime, script: string, what: string): Promise<string> {
  const result = await root.run(`flock ${LOCK} /bin/sh -c ${shq(script)}`, { timeoutMs: SCRIPT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw failed(`could not ${what}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  return result.stdout;
}
