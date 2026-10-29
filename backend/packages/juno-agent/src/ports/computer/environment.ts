/**
 * Bound computer runtime environment plus posix path helpers.
 *
 * Package-owned pure seam: schema and path resolution only. Values come
 * from the host probe; nothing here touches the local machine.
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
  /** Binding working directory; relative tool paths resolve against it. */
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

/** True for a posix-absolute path (the only style a sandbox reports). */
export function isEnvAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/**
 * Resolve a tool path against the binding working directory. Absolute
 * paths pass through; `~/…` is the user's home (when the environment names it); other relative paths join onto the working directory.
 */
export function resolveEnvPath(
  env: Pick<ComputerEnvironment, 'workingDirectory'> & Partial<Pick<ComputerEnvironment, 'home'>>,
  path: string,
): string {
  if (path.length === 0) return env.workingDirectory;
  if (env.home !== undefined && (path === '~' || path.startsWith('~/'))) return posix.join(env.home, path.slice(1));
  if (isEnvAbsolute(path)) return posix.normalize(path);
  return posix.join(env.workingDirectory, path);
}
