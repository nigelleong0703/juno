/** Options of `juno serve`: the base URL and token come from JUNO_BASE_URL and JUNO_TOKEN, or from flags that override them. */

export const USAGE = `usage: juno serve [--base-url URL] [--token TOKEN]

  --base-url URL  the Juno server, e.g. https://juno.example.com (default: $JUNO_BASE_URL)
  --token TOKEN   the bearer token (default: $JUNO_TOKEN). Warning: a flag value is visible in the
                  process list on some systems. Prefer JUNO_TOKEN.
  --embedded      not available yet (see PROTOCOL.md)`;

/** A command line that cannot be run. The message says what is missing. */
export class UsageError extends Error {}

export interface ServeOptions {
  baseUrl: string;
  token: string;
  /** True when the token came from `--token`, so the caller can warn about the process list. */
  tokenFromFlag: boolean;
}

/** Reads the flags (`--base-url`, `--token`) and falls back to the environment for each one not given. */
export function resolveServeOptions(args: readonly string[], env: Readonly<Record<string, string | undefined>>): ServeOptions {
  const flagBaseUrl = flagValue(args, '--base-url');
  const flagToken = flagValue(args, '--token');
  const baseUrl = flagBaseUrl ?? nonEmpty(env.JUNO_BASE_URL);
  const token = flagToken ?? nonEmpty(env.JUNO_TOKEN);
  if (baseUrl === undefined) throw new UsageError('no server given: set JUNO_BASE_URL or pass --base-url');
  if (token === undefined) throw new UsageError('no token given: set JUNO_TOKEN or pass --token');
  try {
    new URL(baseUrl);
  } catch {
    throw new UsageError(`the base URL is not an absolute URL: ${baseUrl}`);
  }
  return { baseUrl, token, tokenFromFlag: flagToken !== undefined };
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
