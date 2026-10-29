/**
 * The `SandboxRuntime` over the computer link: every command and file call the platform makes inside a computer
 * (screens, isolation, home, artifacts, Spaces, storage) goes through the daemon, whatever the platform is.
 *
 * The runtime always acts as root (the daemon is root); the agent's own commands are wrapped by `agentRuntime`
 * (isolation.ts) exactly as before. The provider's per-call signal is the default, so a cancelled run reaches the process
 * group inside the computer.
 */
import { failed } from './errors.js';
import type { LinkHub } from './link-hub.js';
import type { CommandResult, RuntimeOptions, SandboxRuntime } from './runtime.js';

/** The working directory commands default to. */
export const WORKSPACE_DIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 120_000;
/** How long a call waits for a link that is not up yet (a computer that is booting dials in within seconds). */
export const LINK_WAIT_MS = 60_000;

export interface LinkRuntimeOptions {
  hub: LinkHub;
  linkId: string;
  signal?: AbortSignal;
  /** Where commands start when the caller names no directory; `/workspace` for a sandbox. */
  cwd?: string;
  /** Overridden in tests. */
  waitMs?: number;
}

export function createLinkRuntime(options: LinkRuntimeOptions): SandboxRuntime {
  const connection = (signal: AbortSignal | undefined) => options.hub.waitFor(options.linkId, options.waitMs ?? LINK_WAIT_MS, signal);

  return {
    async run(command: string, runtimeOptions: RuntimeOptions = {}): Promise<CommandResult> {
      const signal = runtimeOptions.signal ?? options.signal;
      const link = await connection(signal);
      const { stdout, stderr, exitCode } = await link.exec(
        {
          command,
          cwd: runtimeOptions.cwd ?? options.cwd ?? WORKSPACE_DIR,
          timeoutMs: runtimeOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(runtimeOptions.envs === undefined ? {} : { envs: runtimeOptions.envs }),
        },
        signal,
      );
      return { stdout, stderr, exitCode };
    },

    async readBytes(path: string): Promise<Uint8Array> {
      return (await connection(options.signal)).readFile(path, options.signal);
    },

    async readText(path: string): Promise<string> {
      return Buffer.from(await this.readBytes(path)).toString('utf8');
    },

    async writeText(path: string, content: string): Promise<void> {
      await this.writeBytes(path, Buffer.from(content, 'utf8'));
    },

    async writeBytes(path: string, content: Uint8Array): Promise<void> {
      const link = await connection(options.signal);
      try {
        await link.writeFile(path, Buffer.from(content), options.signal);
      } catch (error) {
        throw failed(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
