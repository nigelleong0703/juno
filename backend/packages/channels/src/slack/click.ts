/**
 * Slack button taps (`block_actions`). The api route acknowledges Slack within its 3 seconds; the tapped message is then rewritten
 * with `chat.update` (buttons dropped, the choice shown) so it cannot be tapped twice. A non-owner on a decision gets an ephemeral
 * note through the interaction's `response_url`.
 */
import { z } from 'zod';
import { NOT_OWNER_TEXT, STALE_TEXT, type ParsedClick } from '../click.js';
import { chosenBlocks } from './render.js';

const interactionSchema = z.object({
  type: z.literal('block_actions'),
  user: z.object({ id: z.string(), name: z.string().optional(), username: z.string().optional() }),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).min(1),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ message_ts: z.string().optional(), channel_id: z.string().optional() }).optional(),
  message: z.object({ ts: z.string().optional(), blocks: z.array(z.record(z.string(), z.unknown())).optional() }).optional(),
  response_url: z.string().optional(),
});

/** The `payload` of a Slack interaction request (a form field holding JSON) as a tap on one of our buttons, or undefined for anything else. */
export function parseSlackClick(payloadJson: unknown): ParsedClick | undefined {
  if (typeof payloadJson !== 'string') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  const parsed = interactionSchema.safeParse(raw);
  const action = parsed.success ? parsed.data.actions[0] : undefined;
  if (!parsed.success || action === undefined || !action.action_id.startsWith('jn:')) return undefined;
  const interaction = parsed.data;
  return {
    token: action.action_id,
    from: { id: interaction.user.id, name: interaction.user.name ?? interaction.user.username ?? '' },
    async ack({ fetchFn, token }, outcome) {
      if (outcome.status === 'done') {
        const ts = interaction.message?.ts ?? interaction.container?.message_ts;
        const channel = interaction.channel?.id ?? interaction.container?.channel_id;
        if (token !== undefined && ts !== undefined && channel !== undefined) {
          await fetchFn('https://slack.com/api/chat.update', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token },
            body: JSON.stringify({ channel, ts, text: '✓ ' + outcome.label, blocks: chosenBlocks(interaction.message?.blocks ?? [], outcome.label) }),
          }).catch(() => undefined);
        }
      } else if (interaction.response_url !== undefined) {
        await fetchFn(interaction.response_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: outcome.status === 'not-owner' ? NOT_OWNER_TEXT : STALE_TEXT }),
        }).catch(() => undefined);
      }
      return undefined;
    },
  };
}
