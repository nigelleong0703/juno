/**
 * Display file state after a restart (BACKEND §7.11): what a cold-started computer leaves behind that the next screen boot
 * must not trust. Runs as root through the computer link; the pid files of a dead generation are dropped, never killed.
 */
import { failed } from './errors.js';
import type { SandboxRuntime } from './runtime.js';
import { chromiumProfileExpr, pidDir, rootDir, shq } from './screen-boot.js';

const PROBE_TIMEOUT_MS = 15_000;
const CLEAN_TIMEOUT_MS = 30_000;

/** True when Xvfb genuinely answers on a display (ground truth, not a pidfile). */
export async function displayXvfbLive(runtime: SandboxRuntime, displayNo: number, signal?: AbortSignal): Promise<boolean> {
  // The display has no `-ac` any more: the boot recorded where its cookie is (`xauth` in its state dir).
  const result = await runtime.run(`XAUTHORITY="$(cat ${shq(`${rootDir(displayNo)}/xauth`)} 2>/dev/null)" xdpyinfo -display :${displayNo} >/dev/null 2>&1`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
  return result.exitCode === 0;
}

/**
 * Drop one display's file state: its pid/log dir plus the X lock and socket. Never kills:
 * after a restart the pids are dead or recycled, and a recycled pid belongs to an unrelated
 * process. Profiles and /workspace are untouched.
 */
export async function cleanDisplayState(runtime: SandboxRuntime, displayNo: number, signal?: AbortSignal): Promise<void> {
  const result = await runtime.run(
    `rm -rf ${shq(pidDir(displayNo))} ${shq(rootDir(displayNo))} ${shq(`/tmp/.X${displayNo}-lock`)} ${shq(`/tmp/.X11-unix/X${displayNo}`)}`,
    { timeoutMs: CLEAN_TIMEOUT_MS, signal },
  );
  if (result.exitCode !== 0) {
    throw failed(`could not clean display :${displayNo} file state: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
}

/**
 * Drop one agent's Chromium singleton locks (lock/socket/cookie), never the profile.
 * Only for a certainly-dead generation: with a live browser this would break it.
 */
export async function cleanChromiumSingletons(runtime: SandboxRuntime, agentId: string, signal?: AbortSignal): Promise<void> {
  const profile = chromiumProfileExpr(agentId);
  const result = await runtime.run(
    `rm -f ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie`,
    { timeoutMs: CLEAN_TIMEOUT_MS, signal },
  );
  if (result.exitCode !== 0) {
    throw failed(`could not clean Chromium singleton locks: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
}
