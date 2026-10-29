/**
 * The bound computer's runtime environment: what the sandbox actually reports, not what the
 * image or the agent assumes. Every shell/file action and the run context resolve against the
 * same binding working directory, so a relative path means the same directory everywhere.
 *
 * Nothing here touches the local machine: the values come from one remote probe (E2B) or from
 * explicit test doubles (fake). A future local adapter may return a local root through this
 * same shape, but localhost shell fallback is never implied by these helpers.
 */
import { posix } from 'node:path';
import { z } from 'zod';

export const computerEnvironmentSchema = z.object({
  /** Raw OS release, e.g. `Linux 6.8.0 x86_64`. */
  os: z.string().min(1),
  /** Normalized platform, e.g. `linux`. */
  platform: z.string().min(1),
  /** Sandbox user the agent commands run as. */
  user: z.string().min(1),
  /** That user's home directory. */
  home: z.string().min(1),
  /**
   * The binding's working directory. Derived by the provider from the remote sandbox (the
   * image owns `/workspace` today), never from the agent identity and never from the local
   * process.
   */
  workingDirectory: z.string().min(1),
  pathStyle: z.literal('posix'),
  /** `mac`: the user's own Mac that joined as a computer (My Mac); otherwise the platform's sandbox. */
  kind: z.enum(['sandbox', 'mac']),
  /** A Mac only: what it declared it can do right now (`files`, `shell`, `screen`, `input`, `browser`, `audio`, `apps`). */
  device: z.object({ name: z.string(), osVersion: z.string(), actions: z.array(z.string()) }).optional(),
});
export type ComputerEnvironment = z.infer<typeof computerEnvironmentSchema>;

export function parseEnvironment(value: unknown): ComputerEnvironment {
  return computerEnvironmentSchema.parse(value);
}

/** One remote probe for os/platform/user/home/cwd; the output parses with `parseEnvironmentOutput`. */
export const ENVIRONMENT_COMMAND =
  `printf 'os=%s\\n' "$(uname -sr)"; ` +
  `printf 'platform=%s\\n' "$(uname -s)"; ` +
  `printf 'user=%s\\n' "$(id -un)"; ` +
  `printf 'home=%s\\n' "$HOME"; ` +
  `printf 'cwd=%s\\n' "$PWD"`;

/** Read one `key=value` probe output; every field is required so a partial read fails loudly. */
export function parseEnvironmentOutput(stdout: string): ComputerEnvironment {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const cut = line.indexOf('=');
    if (cut < 1) continue;
    fields.set(line.slice(0, cut).trim(), line.slice(cut + 1).trim());
  }
  const raw = (key: string): string | undefined => {
    const value = fields.get(key);
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const os = raw('os');
  const platform = raw('platform');
  const user = raw('user');
  const home = raw('home');
  const cwd = raw('cwd');
  if (!os || !platform || !user || !home || !cwd) {
    throw new Error(`incomplete sandbox environment probe: ${stdout.slice(0, 200)}`);
  }
  return parseEnvironment({
    os,
    platform: normalizePlatform(platform),
    user,
    home,
    workingDirectory: cwd,
    pathStyle: 'posix',
    kind: 'sandbox',
  });
}

function normalizePlatform(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.startsWith('linux')) return 'linux';
  if (lower.startsWith('darwin')) return 'darwin';
  return lower;
}

/** True for a posix-absolute path (the only style a sandbox reports). */
export function isEnvAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/**
 * Resolve a tool path against the binding's working directory. Absolute paths pass through
 * (the sandbox enforces their permissions); relative paths join onto the environment.
 */
export function resolveEnvPath(env: Pick<ComputerEnvironment, 'workingDirectory'>, path: string): string {
  if (path.length === 0) return env.workingDirectory;
  if (isEnvAbsolute(path)) return posix.normalize(path);
  return posix.join(env.workingDirectory, path);
}
