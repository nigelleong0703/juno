/**
 * memoryd's HTTP surface (BACKEND §2.4): one POST route per `routes` entry in contract.ts, each run inside the owner's scope. It
 * serves a `MemoryPort`; it does not decide anything itself, so the presence rules are the port's (memory-graph's `memoryFor`) and
 * are enforced here for every caller. Auth is the shared bearer (401 without it); the owner header must match the body (403).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { z } from 'zod';
import { IdentityError } from '@agent-desktop/memory-graph/identity';
import { MemoryItemError } from '@agent-desktop/memory-graph/memory';
import { RelationError } from '@agent-desktop/memory-graph/relations';
import { runWithOwner } from 'juno-agent/owner-context';
import { HomeConflictError, HomeUnavailableError } from 'juno-agent/modules/home/service';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import { decodeClaimsContext, encodeClaimsContext, routes, type DomainErrorKind } from './contract.js';

export interface MemoryServerOptions {
  port: MemoryPort;
  /** The bearer agentd presents (MEMORYD_TOKEN). Empty refuses every request: there is no built-in default. */
  token: string;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

interface ErrorBody {
  error: { kind: string; code?: string; message: string; path?: string };
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compares two secrets without leaking the length or the first mismatch. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** The status and body of a failure: a refusal keeps its kind (and code, or path); anything else is a 500 with no detail. */
function failureOf(error: unknown): { status: 404 | 409 | 422 | 500 | 503; body: ErrorBody; logged: boolean } {
  const refusal = (kind: DomainErrorKind, code: string, message: string): { status: 404 | 422; body: ErrorBody; logged: boolean } => ({
    status: code === 'not_found' ? 404 : 422,
    body: { error: { kind, code, message } },
    logged: false,
  });
  if (error instanceof MemoryItemError) return refusal('MemoryItemError', error.code, error.message);
  if (error instanceof IdentityError) return refusal('IdentityError', error.code, error.message);
  if (error instanceof RelationError) return refusal('RelationError', error.code, error.message);
  if (error instanceof HomeConflictError) return { status: 409, body: { error: { kind: 'HomeConflictError', message: error.message, path: error.path } }, logged: false };
  if (error instanceof HomeUnavailableError) return { status: 503, body: { error: { kind: 'HomeUnavailableError', message: error.message } }, logged: false };
  return { status: 500, body: { error: { kind: 'Error', message: 'memoryd failed; see its log' } }, logged: true };
}

export function createMemoryServer(options: MemoryServerOptions): Hono {
  const { port, token } = options;
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/v1/*', async (c, next) => {
    if (token === '' || !sameSecret(c.req.header('authorization') ?? '', `Bearer ${token}`)) {
      return c.json<ErrorBody>({ error: { kind: 'Error', code: 'unauthorized', message: 'missing or invalid bearer token' } }, 401);
    }
    await next();
  });

  const mount = <I extends { ownerId: string }, O>(route: string, input: z.ZodType<I>, run: (request: I) => Promise<O>): void => {
    app.post('/v1/' + route, async (c) => {
      const parsed = input.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json<ErrorBody>({ error: { kind: 'Error', code: 'invalid', message: 'invalid request: ' + parsed.error.message } }, 400);
      if (c.req.header('x-owner-id') !== parsed.data.ownerId) {
        return c.json<ErrorBody>({ error: { kind: 'Error', code: 'not_allowed', message: 'owner header does not match the request' } }, 403);
      }
      try {
        const result = await runWithOwner(parsed.data.ownerId, () => run(parsed.data));
        return c.json(result ?? null);
      } catch (error) {
        const failure = failureOf(error);
        if (failure.logged) options.log?.({ route, err: error }, 'memoryd request failed');
        return c.json(failure.body, failure.status);
      }
    });
  };

  const { log } = options;
  const logging = log === undefined ? {} : { log };

  mount(routes.addItem.route, routes.addItem.input, ({ ownerId, input }) => port.addItem(ownerId, input));
  mount(routes.note.route, routes.note.input, ({ ownerId, input }) => port.note(ownerId, input));
  mount(routes.memoryFor.route, routes.memoryFor.input, ({ ownerId, presence, agentId }) => port.memoryFor(ownerId, presence, agentId));
  mount(routes.search.route, routes.search.input, ({ ownerId, presence, agentId, query, limit }) => port.search({ ownerId, presence, agentId, query, limit }));
  mount(routes.section.route, routes.section.input, ({ delivered, ...rest }) => port.section({ ...rest, delivered: new Set(delivered) }));
  mount(routes.explain.route, routes.explain.input, ({ ownerId, presence, agentId, reference }) => port.explain({ ownerId, presence, agentId, reference }));
  mount(routes.renderViews.route, routes.renderViews.input, async ({ ownerId, agentId }) => {
    await port.renderViews({ ownerId, agentId });
    return { ok: true as const };
  });
  mount(routes.digestContext.route, routes.digestContext.input, async ({ ownerId, items, agents }) => {
    const result = await port.digestContext({ ownerId, items, agents, ...logging });
    return { context: encodeClaimsContext(result.context), prompt: result.prompt };
  });
  mount(routes.applyDigest.route, routes.applyDigest.input, ({ ownerId, agentId, items, claims, context, now }) =>
    port.applyDigest({ ownerId, agentId, items, claims, context: decodeClaimsContext(context), now: new Date(now), ...logging }));
  mount(routes.people.list.route, routes.people.list.input, ({ ownerId }) => port.people.list(ownerId));
  mount(routes.people.ensureOwner.route, routes.people.ensureOwner.input, ({ ownerId, name }) => port.people.ensureOwner(ownerId, name));
  mount(routes.people.createPerson.route, routes.people.createPerson.input, ({ ownerId, name }) => port.people.createPerson(ownerId, name));
  mount(routes.people.resolve.route, routes.people.resolve.input, async ({ ownerId, accountId }) => (await port.people.resolve(ownerId, accountId)) ?? null);
  mount(routes.people.findAccount.route, routes.people.findAccount.input, async ({ ownerId, input }) => (await port.people.findAccount(ownerId, input)) ?? null);
  mount(routes.people.accountsOf.route, routes.people.accountsOf.input, ({ ownerId, personId }) => port.people.accountsOf(ownerId, personId));
  mount(routes.people.accountsWithPrefix.route, routes.people.accountsWithPrefix.input, ({ ownerId, prefix }) => port.people.accountsWithPrefix(ownerId, prefix));
  mount(routes.people.listAccounts.route, routes.people.listAccounts.input, ({ ownerId }) => port.people.listAccounts(ownerId));
  mount(routes.people.linkAccount.route, routes.people.linkAccount.input, ({ ownerId, accountId, personId }) => port.people.linkAccount(ownerId, accountId, personId));
  mount(routes.relations.record.route, routes.relations.record.input, ({ ownerId, input }) => port.relations.record(ownerId, input));
  mount(routes.relations.currentOf.route, routes.relations.currentOf.input, ({ ownerId, personId }) => port.relations.currentOf(ownerId, personId));
  // Owner-only admin edits: called by agentd's owner routes, never by the agent runtime (they carry no presence of their own).
  const owner = port.owner;
  mount(routes.owner.people.route, routes.owner.people.input, ({ ownerId }) => owner.people(ownerId));
  mount(routes.owner.possibleMatches.route, routes.owner.possibleMatches.input, ({ ownerId }) => owner.possibleMatches(ownerId));
  mount(routes.owner.unlinkAccount.route, routes.owner.unlinkAccount.input, ({ ownerId, accountId }) => owner.unlinkAccount(ownerId, accountId));
  mount(routes.owner.renamePerson.route, routes.owner.renamePerson.input, ({ ownerId, personId, name }) => owner.renamePerson(ownerId, personId, name));
  mount(routes.owner.confirmRelation.route, routes.owner.confirmRelation.input, ({ ownerId, relationId }) => owner.confirmRelation(ownerId, relationId));
  mount(routes.owner.deleteRelation.route, routes.owner.deleteRelation.input, async ({ ownerId, relationId }) => {
    await owner.deleteRelation(ownerId, relationId);
    return { ok: true as const };
  });
  mount(routes.owner.items.route, routes.owner.items.input, ({ ownerId, aboutPersonId, status, topic }) => owner.items(ownerId, { aboutPersonId, status, topic }));
  mount(routes.owner.topics.route, routes.owner.topics.input, ({ ownerId }) => owner.topics(ownerId));
  mount(routes.owner.updateItem.route, routes.owner.updateItem.input, ({ ownerId, id, patch }) => owner.updateItem(ownerId, id, patch));
  mount(routes.owner.deleteItem.route, routes.owner.deleteItem.input, async ({ ownerId, id }) => {
    await owner.deleteItem(ownerId, id);
    return { ok: true as const };
  });
  mount(routes.forget.route, routes.forget.input, (request) => port.forget(request));
  mount(routes.saveView.route, routes.saveView.input, (request) => port.saveView(request));

  return app;
}
