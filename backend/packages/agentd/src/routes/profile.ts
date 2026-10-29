/**
 * `GET|PUT /v1/profile` (BACKEND 8.7): the account profile, one document per owner. Not secret: a flat list of key/value details lives here so the agent can fill them into pages itself. Secrets never do (they go through request_secure_input).
 */
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { profileIdFor, profileSchema, putProfileInputSchema, type Profile, type ProfileEntry } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';

export function registerProfile(app: Hono, deps: AgentdDeps): void {
  app.get('/v1/profile', async (c) => {
    const row = await deps.store.get('profiles', profileIdFor(getOwnerId(c)));
    // The store adds its own columns (id, ownerId); only the contract's fields leave.
    const body: Profile = profileSchema.strip().parse(row ?? { entries: [] });
    return c.json(body);
  });

  // The user's edits replace the list; an entry that did not change keeps its source, a new or changed one becomes the user's.
  app.put('/v1/profile', zValidator('json', putProfileInputSchema), async (c) => {
    const id = profileIdFor(getOwnerId(c));
    const updatedAt = new Date().toISOString();
    const before = new Map(profileSchema.strip().parse((await deps.store.get('profiles', id)) ?? { entries: [] }).entries.map((entry) => [entry.id, entry]));
    const entries: ProfileEntry[] = c.req.valid('json').entries.map((entry) => {
      const old = before.get(entry.id);
      const unchanged = old !== undefined && old.key === entry.key && old.value === entry.value;
      return { ...entry, source: unchanged ? old.source : { by: 'user', at: updatedAt } };
    });
    await deps.store.put('profiles', { entries, id, updatedAt });
    const body: Profile = { entries, updatedAt };
    return c.json(body);
  });
}
