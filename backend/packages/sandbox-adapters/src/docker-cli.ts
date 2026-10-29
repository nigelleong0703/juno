/**
 * The local provider's only host dependency: the `docker` CLI, spawned with an argv array and no
 * shell, so nothing a caller passes can be re-interpreted by a shell. Standard input carries the
 * command text that must not appear in the host process list (a boot program embeds the display's
 * VNC password); every call is bounded so a wedged daemon cannot hang computerd, and a killed call
 * is reported as a truthful timeout or cancellation rather than a silent success.
 */
import { spawn } from 'node:child_process';
import { aborted, unavailable } from './errors.js';

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerOptions {
  /** Text written to the CLI's stdin (a shell program, or file content for a redirect). */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra environment of the CLI process itself: how a value reaches `docker run -e NAME` without appearing in the argument list. */
  env?: Record<string, string>;
}

export interface DockerCli {
  /** Run one docker subcommand. A non-zero exit is DATA here; the caller decides what it means. */
  run(args: string[], options?: DockerOptions): Promise<DockerResult>;
}

export const DOCKER_BIN = 'docker';

/**
 * True only for the docker CLI's own daemon/socket failures. A bare "connection refused" is NOT
 * enough: output from a program running inside the container (a dead browser's CDP port) says the
 * same thing and must not read as "Docker Desktop is down".
 */
export function isDockerDaemonDown(text: string): boolean {
  return /cannot connect to the docker daemon|is the docker daemon running|error during connect|denied.*docker\.sock|dial (unix|tcp)[^\n]*(docker\.sock|:2375|:2376)[^\n]*(connection refused|no such file)/i.test(text);
}
const DEFAULT_TIMEOUT_MS = 120_000;

export function createDockerCli(bin: string = DOCKER_BIN): DockerCli {
  return {
    run(args, options = {}) {
      const subcommand = args[0] ?? 'command';
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise<DockerResult>((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let onAbort: () => void = () => undefined;
        // Docker can exit before reading stdin (an unknown container, a stopped daemon); an
        // unwatched stdin then raises EPIPE and crashes computerd. Swallow it: the close event
        // below still reports the real exit code and stderr.
        const onStdinError: () => void = () => undefined;
        child.stdin.on('error', onStdinError);
        const release = () => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          child.stdin.off('error', onStdinError);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          release();
          child.kill('SIGKILL');
          reject(error);
        };
        onAbort = () => fail(aborted(`docker ${subcommand} was cancelled`));
        child.on('error', (error) => fail(spawnFailure(error, bin)));
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          release();
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
        // Single const assignment, armed in the same place as before: the release() closure
        // only reads it once this promise executor has finished, so timeout and cancellation
        // behave exactly as they did with the separate declaration.
        const timer = setTimeout(() => fail(unavailable(`docker ${subcommand} timed out after ${timeoutMs}ms`)), timeoutMs);
        if (options.signal?.aborted) return onAbort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdin.end(options.stdin ?? '');
      });
    },
  };
}

function spawnFailure(error: unknown, bin: string): Error {
  if (isErrno(error) && error.code === 'ENOENT') {
    return unavailable(bin === DOCKER_BIN ? 'the docker CLI was not found on PATH (install and start Docker Desktop)' : `the ${bin} CLI was not found on PATH`);
  }
  return unavailable(`could not run ${bin}: ${error instanceof Error ? error.message : String(error)}`);
}

function isErrno(error: unknown): error is { code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error;
}
