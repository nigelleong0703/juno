import { z } from 'zod';
import { deriveRequestOutcome, resolveRequestInputSchema } from '@agent-desktop/public-contracts';
import type { Request, ResolveRequestInput } from '@agent-desktop/public-contracts';

/** The channel event held while the owner answers "Is this you?" (see agentd channels/owner-claim.ts). */
export const channelClaimSchema = z.object({
  kind: z.string().min(1),
  channelId: z.string().min(1),
  externalId: z.string().min(1),
  event: z.object({
    threadId: z.string().optional(),
    chatId: z.string().optional(),
    chatType: z.enum(['private', 'group']),
    externalMessageId: z.string().optional(),
    from: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
    text: z.string(),
  }),
});
export type ChannelClaim = z.infer<typeof channelClaimSchema>;

/** The rule a "Want fewer of these?" question writes when the owner says yes (BACKEND §5.10): a soft rule about a type of proactive message. */
export const silenceQuestionSchema = z.object({ text: z.string().min(1), source: z.string().min(1) });
export type SilenceQuestion = z.infer<typeof silenceQuestionSchema>;

/** The routine a "<name> first trial run: turn it on?" question decides (BACKEND §3.6.4): the first option turns it on, the other turns it off. */
export const previewQuestionSchema = z.object({ routineId: z.string().min(1) });
export type PreviewQuestion = z.infer<typeof previewQuestionSchema>;

/**
 * Internal view of a stored `requests` document. The public `Request` contract is what clients see;
 * the store additionally carries a few runtime-only fields. They live here, outside `public/`, so the
 * client contract copy stays clean and none of them can leak by being declared on a public schema.
 *
 * - `awakeableId`: the awakeable handle a suspended run installs so the resolve route can wake it.
 *   Internal only: clients must never see it (see `toPublicRequest`).
 * - `wakeDeliveredAt`: when agentd delivered the resolution to the run/session (dedupes retries).
 * - `resolution`: the exact validated decision the resolve route persisted, re-delivered on retry.
 * - `tool`: the raw tool name an approval was raised for (`<connector>_<name>`); the public `payload.action` is plain words.
 *   "Always allow" and the old per-tool rules key on it.
 */
export interface StoredRequest extends Request {
  awakeableId?: string;
  wakeDeliveredAt?: string;
  resolution?: ResolveRequestInput;
  tool?: string;
  /** The user typed a message while a run waited on this request: the run moved on and the request stays open. A later decision wakes the agent. */
  interrupted?: boolean;
  /** The user's message arrived before the run installed its awakeable on this request, so there was nothing to resolve: the run reads this when it does, and ends the wait at once. */
  interruptRequested?: boolean;
  /** An "Is this you?" request for an unbound channel: the first private message from that sender, held until the owner answers. */
  channelClaim?: ChannelClaim;
  /** A "Want fewer of these?" question the silence rule raised: yes writes this rule, no writes nothing; the answer is not a chat message. */
  silenceQuestion?: SilenceQuestion;
  /** The trial-run card of a routine the agent started on its own: the answer turns the routine on or off; the answer is not a chat message and wakes nobody. */
  previewQuestion?: PreviewQuestion;
  /**
   * Private link from the one question the agent asked the person about an uncertain action (`ask_about_uncertain_action`) to the fenced step
   * it is about. `pending`: asked; `authorized`: the person said to do it again (one repeat, consumed by the next identical call);
   * `declined`: the person said not to; `consumed` / `completed`: the authorized repeat started / finished.
   */
  reconciliation?: {
    stepId: string; tool: string; fingerprint: string;
    connectionId?: string; account?: string;
    state: 'pending' | 'authorized' | 'declined' | 'consumed' | 'completed';
    attemptStepId?: string;
  };
}

/**
 * How long an approval card stays open for a decision (BACKEND 8.0c). A "yes" later than this after the card was raised is refused and the
 * run that asked is told to ask again: what the person looked at a day ago may no longer be what they want.
 */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

/** Whether a decision at `at` (ms) comes too late for this approval. Only approvals expire. */
export function approvalExpired(request: Pick<Request, 'kind' | 'createdAt'>, at: number): boolean {
  const raised = Date.parse(request.createdAt);
  return request.kind === 'approval' && Number.isFinite(raised) && at - raised > APPROVAL_WINDOW_MS;
}

/** The runtime-only keys, in one place so stripping and parsing cannot drift apart. */
export const STORED_REQUEST_INTERNAL_KEYS = ['awakeableId', 'wakeDeliveredAt', 'resolution', 'tool', 'interrupted', 'interruptRequested', 'channelClaim', 'silenceQuestion', 'previewQuestion', 'reconciliation'] as const;

const nonEmptyString = z.string().min(1);

/**
 * The runtime-only fields as they may appear on a stored doc. Each field is validated on its own, so a
 * malformed legacy value is dropped (treated as absent) instead of failing the whole document.
 */
export const storedRequestInternalsSchema = z.object({
  awakeableId: nonEmptyString.optional().catch(undefined),
  wakeDeliveredAt: nonEmptyString.optional().catch(undefined),
  resolution: resolveRequestInputSchema.optional().catch(undefined),
  tool: nonEmptyString.optional().catch(undefined),
  interrupted: z.boolean().optional().catch(undefined),
  interruptRequested: z.boolean().optional().catch(undefined),
  channelClaim: channelClaimSchema.optional().catch(undefined),
  silenceQuestion: silenceQuestionSchema.optional().catch(undefined),
  previewQuestion: previewQuestionSchema.optional().catch(undefined),
  reconciliation: z.object({
    stepId: nonEmptyString, tool: nonEmptyString, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    connectionId: nonEmptyString.optional(), account: nonEmptyString.optional(),
    state: z.enum(['pending', 'authorized', 'declined', 'consumed', 'completed']),
    attemptStepId: nonEmptyString.optional(),
  }).optional().catch(undefined),
});

/** The stored document without the internal keys and without the derived `outcome` (which is never written). */
function withoutInternals(request: Request): Request {
  const copy: Record<string, unknown> = { ...request };
  for (const key of STORED_REQUEST_INTERNAL_KEYS) delete copy[key];
  delete copy['outcome'];
  return copy as unknown as Request;
}

/** Public request fields only: every internal key removed, `outcome` derived. Safe for any response or event. */
export function toPublicRequest(request: Request): Request {
  const copy = withoutInternals(request);
  const outcome = deriveRequestOutcome(copy);
  return outcome === undefined ? copy : { ...copy, outcome };
}

/** A stored doc with its internal fields validated; a malformed internal field is dropped. */
export function parseStoredRequest(request: Request): StoredRequest {
  const parsed = storedRequestInternalsSchema.parse(request);
  const stored: StoredRequest = withoutInternals(request);
  if (parsed.awakeableId !== undefined) stored.awakeableId = parsed.awakeableId;
  if (parsed.wakeDeliveredAt !== undefined) stored.wakeDeliveredAt = parsed.wakeDeliveredAt;
  if (parsed.resolution !== undefined) stored.resolution = parsed.resolution;
  if (parsed.tool !== undefined) stored.tool = parsed.tool;
  if (parsed.interrupted === true) stored.interrupted = true;
  if (parsed.interruptRequested === true) stored.interruptRequested = true;
  if (parsed.channelClaim !== undefined) stored.channelClaim = parsed.channelClaim;
  if (parsed.silenceQuestion !== undefined) stored.silenceQuestion = parsed.silenceQuestion;
  if (parsed.previewQuestion !== undefined) stored.previewQuestion = parsed.previewQuestion;
  if (parsed.reconciliation !== undefined) stored.reconciliation = parsed.reconciliation;
  return stored;
}
