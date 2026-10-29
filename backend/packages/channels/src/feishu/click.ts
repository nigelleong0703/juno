/**
 * Feishu / Lark card taps (`card.action.trigger`). The long-connection handler returns the new card, so a tap redraws the message
 * with the buttons replaced by the choice; a non-owner gets a toast and the card stays.
 */
import { z } from 'zod';
import { NOT_OWNER_TEXT, STALE_TEXT, type ParsedClick } from '../click.js';
import { feishuCard } from './render.js';

const actionSchema = z.object({
  operator: z.object({ open_id: z.string().optional(), name: z.string().optional() }).optional(),
  action: z.object({ value: z.unknown().optional() }).optional(),
});

/** A card button press of ours with who pressed it, or undefined for anything else. */
export function parseFeishuClick(event: unknown): ParsedClick | undefined {
  const parsed = actionSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const value = parsed.data.action?.value;
  const token = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['t'] : undefined;
  const id = parsed.data.operator?.open_id;
  if (typeof token !== 'string' || !token.startsWith('jn:') || id === undefined) return undefined;
  return {
    token,
    from: { id, name: parsed.data.operator?.name ?? '' },
    redraws: true,
    async ack({ redraw }, outcome) {
      if (outcome.status !== 'done') return { toast: { type: 'error', content: outcome.status === 'not-owner' ? NOT_OWNER_TEXT : STALE_TEXT } };
      return {
        toast: { type: 'success', content: outcome.label },
        ...(redraw === undefined ? {} : { card: { type: 'raw', data: feishuCard(redraw, outcome.label) } }),
      };
    },
  };
}
