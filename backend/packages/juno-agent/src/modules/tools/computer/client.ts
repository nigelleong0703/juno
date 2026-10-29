/**
 * Late binding for the injected ComputerClient.
 *
 * The registry is built once, before any agent exists, but the sandbox client is owned by whoever runs the agent
 * loop (the runner). Taking a getter keeps the tools ignorant of config and lets the runner return the client only
 * when the sandbox is configured (COMPUTERD_URL), or `undefined` to keep computer tools out of the registry.
 */

import type { ComputerClient, ComputerClientProvider, ComputerEnvironment, ComputerTarget } from '../../../ports/computer/index.js';
import { ComputerError, isComputerError } from './contract.js';

export type { ComputerClientProvider };

/** Start of the error text for a deployment without a sandbox: a configuration fact, not a computer that can recover. */
export const NOT_CONFIGURED_PREFIX = 'Computer is not available:';

/** The client when one is available, otherwise a clear "not configured" capability error. */
export function requireComputerClient(provider: ComputerClientProvider | undefined): ComputerClient {
  const client = provider?.();
  if (!client) {
    throw new ComputerError(
      'unavailable',
      `${NOT_CONFIGURED_PREFIX} this agent has no sandbox screen on this deployment (COMPUTERD_URL is not configured).`,
    );
  }
  return client;
}

/** What the environment callbacks need: the requesting agent, the current run and its signal. */
export interface EnvironmentRequest {
  agentId: string;
  runId: string;
  signal: AbortSignal;
  /** Which of the agent's computers; absent is the sandbox. */
  on?: ComputerTarget;
}

/**
 * One injected lookup for the bound computer environment. The registry memoizes it per run, so
 * every tool in a run resolves relative paths and the shell directory against the same value.
 */
export type ComputerEnvironmentSource = (request: EnvironmentRequest) => Promise<ComputerEnvironment>;

/** Share one environment fetch across every tool call of a run (success or truthful failure). */
export function createRunEnvironment(
  fetch: (agentId: string, signal: AbortSignal, on?: ComputerTarget) => Promise<ComputerEnvironment>,
): ComputerEnvironmentSource {
  const cache = new Map<string, Promise<ComputerEnvironment>>();
  return (request) => {
    const key = request.agentId + ':' + request.runId + ':' + (request.on ?? 'sandbox');
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = fetch(request.agentId, request.signal, request.on);
    cache.set(key, pending);
    return pending;
  };
}

/**
 * The run environment, or a truthful unavailable error when no source is wired or the bound
 * computer cannot be read. An abort is never masked: it rethrows so the run fence records
 * an interruption instead of a tool error.
 */
export async function requireEnvironment(
  source: ComputerEnvironmentSource | undefined,
  request: EnvironmentRequest,
): Promise<ComputerEnvironment> {
  if (!source) {
    throw new ComputerError(
      'unavailable',
      'Computer environment is not available for this run (no bound computer).',
    );
  }
  try {
    return await source(request);
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (isComputerError(error)) throw error;
    throw new ComputerError('unavailable', 'Computer environment is unavailable: ' + describe(error));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The default source: read the environment from the injected client, memoized per run by the
 * registry. Used when the runner does not supply its own lookup.
 */
export function defaultEnvironmentSource(
  provider: ComputerClientProvider | undefined,
): ComputerEnvironmentSource {
  return createRunEnvironment(async (agentId, signal, on) => {
    const client = requireComputerClient(provider);
    try {
      return await client.environment(agentId, signal, on);
    } catch (error) {
      // A new agent has no screen until its first computer action; a tool call is that action, so start it here
      // (the per-turn context read stays read-only and never boots anything).
      if (!(error instanceof Error && 'code' in error && error.code === 'no_screen') || client.ensureScreen === undefined) throw error;
      await client.ensureScreen(agentId, signal);
      return client.environment(agentId, signal, on);
    }
  });
}
