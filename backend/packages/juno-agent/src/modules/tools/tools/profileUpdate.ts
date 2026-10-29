import { randomUUID } from 'node:crypto';
// profile_update: the agent saves durable, form-fillable facts about the user (name, emails, addresses, membership numbers…)
// as key/value entries on their account profile (BACKEND 8.7). Never for secrets. The user sees and edits the same list in Settings.
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import {
  profileIdFor, profileKeySchema, profileSecretProblem, profileSizeProblem, profileValueSchema, profileVisibilitySchema, type ProfileBody, type ProfileEntry,
} from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { profileAudience, readProfile } from '../../profile/index.js';

const inputSchema = z.object({
  set: z.array(z.object({ key: profileKeySchema, value: profileValueSchema, visibility: profileVisibilitySchema.optional() }).strict()).optional(),
  remove: z.array(profileKeySchema).optional(),
}).strict();

const sameKey = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createProfileUpdateTool(opts: { store: Store }): Tool {
  return {
    name: 'profile_update',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        set: {
          type: 'array',
          description: '',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '' },
              value: { type: 'string', description: '' },
              visibility: { type: 'string', enum: ['private', 'shared'], description: '' },
            },
            required: ['key', 'value'],
            additionalProperties: false,
          },
        },
        remove: { type: 'array', items: { type: 'string' }, description: '' },
      },
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text: 'Error: ' + text }], isError: true });
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('profile_update', args, parsed.error);
      const { set = [], remove = [] } = parsed.data;
      if (set.length === 0 && remove.length === 0) return fail('nothing to save.');
      for (const entry of set) {
        const secret = profileSecretProblem(entry.key, entry.value);
        if (secret !== undefined) return fail(secret + '. Ask for it with request_secure_input only when a page needs it.');
      }
      const audience = await profileAudience(opts.store, { agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] });
      const owner = audience.profileOwnerId;
      if (owner === undefined) return fail('no owner context, so the profile is unavailable.');
      if ((ctx.wake.ownerId ?? ctx.ownerId) !== owner) return fail("only the agent's owner can change the profile.");
      const body: ProfileBody = (await readProfile(opts.store, owner)) ?? { entries: [] };
      const allowPrivate = audience.ownerOnly;
      const refused = () => fail("others are present in this conversation, so private details can't be saved here. Save it as shared if the user wants it available to everyone, or when they are alone with you.");
      const now = new Date().toISOString();
      for (const key of remove) {
        const at = body.entries.findIndex((entry) => sameKey(entry.key, key));
        if (at < 0) return fail(`no entry named "${key}".`);
        if (body.entries[at]?.visibility === 'private' && !allowPrivate) return refused();
        body.entries.splice(at, 1);
      }
      for (const item of set) {
        const at = body.entries.findIndex((entry) => sameKey(entry.key, item.key));
        const existing = at < 0 ? undefined : body.entries[at];
        const visibility = item.visibility ?? existing?.visibility ?? 'private';
        if ((visibility === 'private' || existing?.visibility === 'private') && !allowPrivate) return refused();
        const entry: ProfileEntry = {
          id: existing?.id ?? randomUUID(), key: item.key, value: item.value, visibility,
          source: { by: 'agent', agentId: ctx.agentId, conversationId: ctx.conversationId, at: now },
        };
        if (at < 0) body.entries.push(entry);
        else body.entries[at] = entry;
      }
      const tooBig = profileSizeProblem(body);
      if (tooBig !== undefined) return fail(tooBig + '; ask the user to remove some in Settings.');
      return ctx.step('profile_update', async (): Promise<ToolResult> => {
        await ctx.store.put('profiles', { entries: body.entries, id: profileIdFor(owner), updatedAt: now });
        return { content: [{ type: 'text', text: "Saved to the user's profile; they can edit it in Settings." }] };
      });
    },
  };
}
