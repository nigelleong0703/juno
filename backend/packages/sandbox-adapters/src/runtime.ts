/**
 * The small, SDK-independent runtime the display helpers need: run one shell program and read or
 * write files. `e2b.ts` adapts an E2B `Sandbox` to it and `local.ts` adapts `docker exec`, so
 * screen-boot / screen-file / screen-actions stay provider-agnostic (no fake sandbox object).
 *
 * The command is a full POSIX shell program. Local runtimes deliver it on stdin, never in argv, so
 * a program that embeds a VNC password never appears in the host process list.
 */
export interface RuntimeOptions {
  envs?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxRuntime {
  /** Where the user's home lives in this sandbox; only the test double sets it (real sandboxes use `/juno`). */
  readonly homeRoot?: string;
  run(command: string, options?: RuntimeOptions): Promise<CommandResult>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, content: string): Promise<void>;
  /** Binary-safe write (uploaded files); parent directories must exist. */
  writeBytes(path: string, content: Uint8Array): Promise<void>;
}

/**
 * A thrown value that carries a command's exit result (E2B's `CommandExitError` shape). The
 * `instanceof` check is unreliable across the `@e2b/desktop` (CJS) / `e2b` (ESM) split, so the
 * runtime detects the shape: a real transport failure has none of these fields and still throws.
 */
export function commandExitResult(error: unknown): CommandResult | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('exitCode' in error) || !('stdout' in error) || !('stderr' in error)) return null;
  const { exitCode, stdout, stderr } = error;
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) return null;
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return null;
  return { exitCode, stdout, stderr };
}
