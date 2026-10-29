/**
 * The remote `MemoryPort` (BACKEND §2.4): agentd's runtime reads and writes memory through memoryd when MEMORYD_URL is set. It is the
 * same port as the in-process one, so the runtime does not know which it has. Two things differ:
 *
 * - `graph` stays the process's own graph. The migrations, the nightly memory job and channel ingress still use it (they move with B2).
 * - The `home` and `log` arguments are not sent: memoryd writes the views to the computer with its own home client and logs itself.
 *
 * Degrade: when memoryd cannot answer, `memoryFor` and `section` return empty (one warning a minute) so a run carries on without
 * memory; `search` and the people and relations reads throw `MemoryUnavailableError`; every write throws it too, so the tool that
 * asked reports a clear error and the run does not crash.
 */
import type { z } from 'zod';
import { MemoryItemError } from '@agent-desktop/memory-graph/memory';
import { IdentityError } from '@agent-desktop/memory-graph/identity';
import { RelationError } from '@agent-desktop/memory-graph/relations';
import { HomeConflictError, HomeUnavailableError } from 'juno-agent/modules/home/service';
import type { MemoryGraph } from 'juno-agent/modules/memory/graph';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import { decodeClaimsContext, encodeClaimsContext, errorBodySchema, MemoryUnavailableError, routes } from './contract.js';

export interface RemoteMemoryOptions {
  /** memoryd's base URL, e.g. http://127.0.0.1:8796. */
  url: string;
  /** The bearer memoryd expects (MEMORYD_TOKEN). */
  token: string;
  /** This process's own graph (see the module comment). */
  graph: MemoryGraph;
  log?: (fields: Record<string, unknown>, message: string) => void;
  fetch?: typeof fetch;
  /** Per request; a stalled memoryd must not stall a run. */
  timeoutMs?: number;
}

const DEGRADED_LOG_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

interface Route<I, O> {
  route: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
}

/** A refused operation, rebuilt as the class it was on the server (the callers tell them apart by class). */
function domainError(failure: { kind: string; code?: string; message: string; path?: string }): Error | undefined {
  const code = failure.code === 'not_found' ? 'not_found' : 'invalid';
  switch (failure.kind) {
    case 'MemoryItemError': return new MemoryItemError(code, failure.message);
    case 'IdentityError': return new IdentityError(code, failure.message);
    case 'RelationError': return new RelationError(code, failure.message);
    case 'HomeConflictError': return new HomeConflictError(failure.path ?? failure.message);
    case 'HomeUnavailableError': return new HomeUnavailableError(failure.message);
    default: return undefined;
  }
}

export function createRemoteMemoryPort(options: RemoteMemoryOptions): MemoryPort {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.url.endsWith('/') ? options.url : options.url + '/';
  let lastWarnAt: number | undefined;

  const call = async <I extends { ownerId: string }, O>(endpoint: Route<I, O>, request: I): Promise<O> => {
    let response: Response;
    try {
      response = await doFetch(new URL('v1/' + endpoint.route, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${options.token}`, 'x-owner-id': request.ownerId },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MemoryUnavailableError(`memoryd did not answer ${endpoint.route} (${error instanceof Error ? error.message : String(error)})`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = errorBodySchema.safeParse(body);
      if (failure.success) {
        const domain = domainError(failure.data.error);
        if (domain !== undefined) throw domain;
        throw new MemoryUnavailableError(`memoryd refused ${endpoint.route} with ${String(response.status)}: ${failure.data.error.message}`);
      }
      throw new MemoryUnavailableError(`memoryd answered ${endpoint.route} with ${String(response.status)}`);
    }
    const parsed = endpoint.output.safeParse(body);
    if (!parsed.success) throw new MemoryUnavailableError(`memoryd returned an invalid ${endpoint.route} response`);
    return parsed.data;
  };

  /** A read that degrades: memoryd unreachable gives `empty` and one warning a minute; a refusal still throws. */
  const readOr = async <T>(read: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof MemoryUnavailableError)) throw error;
      const now = Date.now();
      if (lastWarnAt === undefined || now - lastWarnAt >= DEGRADED_LOG_INTERVAL_MS) {
        lastWarnAt = now;
        options.log?.({ err: error }, 'memoryd unavailable: memory read degraded to empty');
      }
      return empty;
    }
  };

  return {
    graph: options.graph,
    addItem: (ownerId, input) => call(routes.addItem, { ownerId, input }),
    note: (ownerId, input) => call(routes.note, { ownerId, input }),
    memoryFor: (ownerId, presence, agentId) => readOr(() => call(routes.memoryFor, { ownerId, presence, agentId }), []),
    search: (input) => call(routes.search, input),
    section: (input) => readOr(() => call(routes.section, { ...input, delivered: [...input.delivered] }), { section: '' }),
    explain: (input) => call(routes.explain, input),
    forget: (input) => call(routes.forget, input),
    saveView: (input) => call(routes.saveView, input),
    renderViews: async (input) => {
      await call(routes.renderViews, { ownerId: input.ownerId, agentId: input.agentId });
    },
    owner: {
      people: (ownerId) => call(routes.owner.people, { ownerId }),
      possibleMatches: (ownerId) => call(routes.owner.possibleMatches, { ownerId }),
      unlinkAccount: (ownerId, accountId) => call(routes.owner.unlinkAccount, { ownerId, accountId }),
      renamePerson: (ownerId, personId, name) => call(routes.owner.renamePerson, { ownerId, personId, name }),
      confirmRelation: (ownerId, relationId) => call(routes.owner.confirmRelation, { ownerId, relationId }),
      deleteRelation: async (ownerId, relationId) => {
        await call(routes.owner.deleteRelation, { ownerId, relationId });
      },
      items: (ownerId, filter) => call(routes.owner.items, { ownerId, aboutPersonId: filter.aboutPersonId, status: filter.status, topic: filter.topic }),
      topics: (ownerId) => call(routes.owner.topics, { ownerId }),
      updateItem: (ownerId, id, patch) => call(routes.owner.updateItem, { ownerId, id, patch }),
      deleteItem: async (ownerId, id) => {
        await call(routes.owner.deleteItem, { ownerId, id });
      },
    },
    people: {
      list: (ownerId) => call(routes.people.list, { ownerId }),
      ensureOwner: (ownerId, name) => call(routes.people.ensureOwner, { ownerId, name }),
      createPerson: (ownerId, name) => call(routes.people.createPerson, { ownerId, name }),
      resolve: async (ownerId, accountId) => (await call(routes.people.resolve, { ownerId, accountId })) ?? undefined,
      findAccount: async (ownerId, input) => (await call(routes.people.findAccount, { ownerId, input })) ?? undefined,
      accountsOf: (ownerId, personId) => call(routes.people.accountsOf, { ownerId, personId }),
      accountsWithPrefix: (ownerId, prefix) => call(routes.people.accountsWithPrefix, { ownerId, prefix }),
      listAccounts: (ownerId) => call(routes.people.listAccounts, { ownerId }),
      linkAccount: (ownerId, accountId, personId) => call(routes.people.linkAccount, { ownerId, accountId, personId }),
    },
    relations: {
      record: (ownerId, input) => call(routes.relations.record, { ownerId, input }),
      currentOf: (ownerId, personId) => call(routes.relations.currentOf, { ownerId, personId }),
    },
    digestContext: async (input) => {
      const result = await call(routes.digestContext, { ownerId: input.ownerId, items: input.items, agents: input.agents });
      return { context: decodeClaimsContext(result.context), prompt: result.prompt };
    },
    applyDigest: (input) => call(routes.applyDigest, {
      ownerId: input.ownerId,
      agentId: input.agentId,
      items: input.items,
      claims: input.claims,
      context: encodeClaimsContext(input.context),
      now: input.now.toISOString(),
    }),
  };
}
