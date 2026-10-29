/** Shared path resolution for the sandbox-bound coding file tools. */

import type { ToolContext } from '../../../contracts/index.js';
import {
  defaultEnvironmentSource,
  requireEnvironment,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { isEnvAbsolute, resolveEnvPath, type ComputerTarget } from '../computer/contract.js';

export interface FileToolOptions {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}

/** Resolve a tool path against the run environment; absolute paths pass through to the sandbox, `~/` is the user's home. */
export async function resolveToolPath(opts: FileToolOptions, ctx: ToolContext, path: string, on?: ComputerTarget): Promise<string> {
  if (isEnvAbsolute(path)) return path;
  const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
  const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, ...(on === undefined ? {} : { on }) });
  return resolveEnvPath(env, path);
}
