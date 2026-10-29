/**
 * Discord button taps (`INTERACTION_CREATE`, type 3). A tap is answered through the interaction callback: type 7 rewrites the message
 * with the buttons replaced by one disabled button naming the choice; a non-owner gets an ephemeral note (type 4, flag 64) and the
 * message stays as it was. The callback needs no bot token (the interaction token is in the URL) and must come within 3 seconds.
 */
import { z } from 'zod';
import { NOT_OWNER_TEXT, STALE_TEXT, type ParsedClick } from '../click.js';
import { DISCORD_API } from './api.js';
import { chosenComponents } from './render.js';

const interactionSchema = z.object({
  id: z.string(),
  token: z.string(),
  type: z.number(),
  data: z.object({ custom_id: z.string().optional() }).optional(),
  member: z.object({ user: z.object({ id: z.string(), username: z.string().optional(), global_name: z.string().nullish() }) }).optional(),
  user: z.object({ id: z.string(), username: z.string().optional(), global_name: z.string().nullish() }).optional(),
});

/** A gateway `INTERACTION_CREATE` payload as a tap on one of our buttons, or undefined for anything else. */
export function parseDiscordClick(data: unknown): ParsedClick | undefined {
  const parsed = interactionSchema.safeParse(data);
  if (!parsed.success || parsed.data.type !== 3) return undefined;
  const interaction = parsed.data;
  const customId = interaction.data?.custom_id;
  const user = interaction.member?.user ?? interaction.user;
  if (customId === undefined || !customId.startsWith('jn:') || user === undefined) return undefined;
  return {
    token: customId,
    from: { id: user.id, name: user.global_name ?? user.username ?? '' },
    // The disabled "chosen" button.
    inert: customId === 'jn:x',
    async ack({ fetchFn }, outcome) {
      const body = outcome.status === 'inert' ? { type: 6 }
        : outcome.status === 'done' ? { type: 7, data: { components: chosenComponents(outcome.label) } }
          : { type: 4, data: { content: outcome.status === 'not-owner' ? NOT_OWNER_TEXT : STALE_TEXT, flags: 64 } };
      await fetchFn(DISCORD_API + '/interactions/' + interaction.id + '/' + interaction.token + '/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => undefined);
      return undefined;
    },
  };
}
