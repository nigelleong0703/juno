/**
 * The owner's People segment (BACKEND §9.5, §9.6, §10.17): the people with their accounts and relations, the accounts the owner may
 * link, and the owner's own confirmations (link, unlink, rename, confirm or remove a relation). Every route stays inside the caller's
 * own rows; another owner's ids answer 404.
 */
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { linkAccountInputSchema, renamePersonInputSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { paginateFiltered } from './relationships.js';
import { accountOut, owned, personRef } from './owner-shared.js';

export function registerPeople(app: Hono, deps: AgentdDeps) {
  app.get('/v1/people', (c) => owned(c, deps, async (memory) => {
    const people = (await memory.owner.people(getOwnerId(c))).map((view) => ({
      ...personRef(view.person),
      accounts: view.accounts.map(accountOut),
      relations: view.relations,
      lastActivityAt: view.lastActivityAt,
    }));
    const page = paginateFiltered(people, c.req.query('limit'), c.req.query('cursor'));
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  }));

  app.get('/v1/people/possible-matches', (c) => owned(c, deps, async (memory) => {
    const matches = (await memory.owner.possibleMatches(getOwnerId(c))).map((match) => ({
      id: `${match.account.id}:${match.person.id}`,
      account: accountOut(match.account),
      person: personRef(match.person),
    }));
    const page = paginateFiltered(matches, c.req.query('limit'), c.req.query('cursor'));
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  }));

  app.post('/v1/people/:id/link', zValidator('json', linkAccountInputSchema), (c) => owned(c, deps, async (memory) => {
    const account = await memory.people.linkAccount(getOwnerId(c), c.req.valid('json').accountId, c.req.param('id'));
    return c.json(accountOut(account));
  }));

  app.post('/v1/accounts/:id/unlink', (c) => owned(c, deps, async (memory) => {
    const account = await memory.owner.unlinkAccount(getOwnerId(c), c.req.param('id'));
    return c.json(accountOut(account));
  }));

  app.patch('/v1/people/:id', zValidator('json', renamePersonInputSchema), (c) => owned(c, deps, async (memory) => {
    const person = await memory.owner.renamePerson(getOwnerId(c), c.req.param('id'), c.req.valid('json').name);
    return c.json(personRef(person));
  }));

  app.post('/v1/relations/:id/confirm', (c) => owned(c, deps, async (memory) => {
    const relation = await memory.owner.confirmRelation(getOwnerId(c), c.req.param('id'));
    return c.json({ id: relation.id, confirmed: true as const });
  }));

  app.delete('/v1/relations/:id', (c) => owned(c, deps, async (memory) => {
    await memory.owner.deleteRelation(getOwnerId(c), c.req.param('id'));
    return c.json({});
  }));
}
