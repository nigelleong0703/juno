/**
 * The config gate for the sandbox: COMPUTERD_URL is read from env (absent ⇒ no computer tools registered, so an agent
 * on a deployment without a sandbox never sees a capability that cannot work). The bearer token comes from the loaded
 * config, the same source as the rest of execution; an empty token throws at selection time rather than sending
 * unauthenticated requests that computerd would refuse with 403.
 */

import { ComputerError, type ComputerClient } from '../../../modules/tools/index.js';
import type { BackendConfig } from '../../config.js';
import { createComputerdClient } from './client.js';
import type { MacAccessResolver, OwnerResolver } from './http.js';

export type ComputerClientLog = (fields: Record<string, unknown>, message: string) => void;

const noLog: ComputerClientLog = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOwnerField(agent: unknown, key: string): string | undefined {
  if (!isRecord(agent)) return undefined;
  const value: unknown = agent[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Authoritative owner for one agent id: persisted createdBy (or ownerId when present).
 * Unknown agents and agents without a persisted owner refuse (E41: no config-owner
 * fallback). No global mutable owner: resolved per request, concurrent-safe.
 */
export function createComputerOwnerResolver(
  deps: { getAgent(agentId: string): Promise<unknown> },
): OwnerResolver {
  return async (agentId: string) => {
    const agent = await deps.getAgent(agentId);
    if (!agent) throw new ComputerError('not_allowed', `unknown agent ${agentId}`);
    const owner = readOwnerField(agent, 'createdBy') ?? readOwnerField(agent, 'ownerId');
    if (owner) return owner;
    throw new ComputerError('not_allowed', `unknown owner for agent ${agentId}`);
  };
}

/** Whether the owner lets this agent use their Mac (`macAccess` on the agent). */
export function createMacAccessResolver(
  deps: { getAgent(agentId: string): Promise<unknown> },
): MacAccessResolver {
  return async (agentId) => {
    const agent = await deps.getAgent(agentId);
    return isRecord(agent) && agent['macAccess'] === true;
  };
}

export function selectComputerdClient(
  env: NodeJS.ProcessEnv,
  config: Pick<BackendConfig, 'COMPUTERD_TOKEN'>,
  log: ComputerClientLog = noLog,
  getOwnerId?: OwnerResolver,
  getMacAccess?: MacAccessResolver,
): ComputerClient | undefined {
  const baseUrl = env['COMPUTERD_URL'];
  if (!baseUrl) {
    log({}, 'Computer disabled: set COMPUTERD_URL to enable computer/shell/file/browser tools');
    return undefined;
  }
  const token = config.COMPUTERD_TOKEN;
  if (!token) {
    throw new Error('COMPUTERD_TOKEN is required when COMPUTERD_URL is set: computerd rejects unauthenticated requests');
  }
  log({ baseUrl }, 'Computer sandbox enabled (computerd)');
  return createComputerdClient({
    baseUrl,
    token,
    fetch: (input, init) => fetch(input, init),
    ...(getOwnerId !== undefined ? { getOwnerId } : {}),
    ...(getMacAccess !== undefined ? { getMacAccess } : {}),
  });
}
