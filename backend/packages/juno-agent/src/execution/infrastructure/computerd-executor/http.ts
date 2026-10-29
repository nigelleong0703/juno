/**
 * The one HTTP entry point to computerd: builds a request for a named agent, forwards the caller's AbortSignal so a
 * stop cancels the in-flight call, and turns a non-2xx response into a ComputerError.
 */

import { ComputerError, noteComputerRecreated, noteControlChanged } from '../../../modules/tools/index.js';
import { COMPUTER_RECREATED_HEADER, CONTROL_CHANGED_HEADER } from '../../../ports/computer/index.js';
import { toComputerError } from './errors.js';

export const NO_MAC_ACCESS = 'This agent has no access to your Mac. Use the sandbox (on: "sandbox"), or ask the user to allow Mac access for this agent in its settings.';

export interface RequestSpec {
  method: string;
  path: string;
  agentId: string;
  body?: Record<string, unknown>;
  signal: AbortSignal;
  /** The call acts on the owner's Mac (My Mac) instead of the sandbox: the agent named it (`on: "mac"`) and has access to it. */
  on?: 'sandbox' | 'mac';
}

export interface Requester {
  json(spec: RequestSpec): Promise<unknown>;
  send(spec: RequestSpec): Promise<void>;
}

/** Resolve the authenticated owner for one agent. Awaited per request, never shared mutable state. */
export type OwnerResolver = (agentId: string) => string | Promise<string>;

/** Whether the owner lets this agent use their Mac. Read per request, so a change applies to the next call. */
export type MacAccessResolver = (agentId: string) => Promise<boolean>;

export interface RequesterOptions {
  baseUrl: string;
  token?: string;
  fetch: typeof fetch;
  getOwnerId?: OwnerResolver;
  getMacAccess?: MacAccessResolver;
}

export function createRequester(opts: RequesterOptions): Requester {
  const call = async (spec: RequestSpec): Promise<Response> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      // computerd resolves the screen for this agent only; it never trusts a caller to name a display.
      'x-agent-id': spec.agentId,
    };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    if (opts.getOwnerId) {
      const ownerId = await opts.getOwnerId(spec.agentId);
      if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new ComputerError('not_allowed', `unknown owner for agent ${spec.agentId}`);
      }
      headers['x-owner-id'] = ownerId;
    }
    if (spec.on === 'mac') {
      // The tool policy refuses this earlier with the same words; this is the check nothing can route around.
      if (opts.getMacAccess && !(await opts.getMacAccess(spec.agentId))) throw new ComputerError('not_allowed', NO_MAC_ACCESS);
      headers['x-computer'] = 'mac';
    }
    return opts.fetch(new URL(spec.path, opts.baseUrl).toString(), {
      method: spec.method,
      headers,
      signal: spec.signal,
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    });
  };

  const ensureOk = async (response: Response, path: string, agentId: string): Promise<void> => {
    // computerd replaced a lost computer while serving this call (BACKEND §7.11): the agent hears of it once.
    if (response.headers.get(COMPUTER_RECREATED_HEADER) !== null) noteComputerRecreated(agentId);
    // Control of the surface changed hands while this action ran: its result says so (the person may have acted in between).
    if (response.headers.get(CONTROL_CHANGED_HEADER) !== null) noteControlChanged(agentId);
    if (response.ok) return;
    throw toComputerError(response.status, await readJson(response), path);
  };

  return {
    async json(spec: RequestSpec): Promise<unknown> {
      const response = await call(spec);
      await ensureOk(response, spec.path, spec.agentId);
      return readJson(response);
    },
    async send(spec: RequestSpec): Promise<void> {
      await ensureOk(await call(spec), spec.path, spec.agentId);
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
