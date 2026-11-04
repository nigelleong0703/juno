import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/** Where one outbound delivery goes: a platform chat (a reply, a question card, a document) or a phone's push notification. */
export const outboxKindSchema = z.enum(['channel_reply', 'channel_request_card', 'channel_output', 'push']);
export type OutboxKind = z.infer<typeof outboxKindSchema>;

export const outboxStatusSchema = z.enum(['pending', 'sent', 'dropped']);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

/**
 * Why a delivery was given up on (BACKEND 5.7.11). `retries_exhausted`: eight tries over transient failures. `channel_gone`: the chat was deleted or
 * the bot removed. `token_invalid`: the platform refused the credential (a push token the phone no longer has). `content_rejected`: the platform refused
 * this message. `source_gone`: the reply was deleted before it went out. `superseded`: nothing to deliver any more (a question that was answered meanwhile).
 */
export const outboxDroppedReasonSchema = z.enum(['retries_exhausted', 'channel_gone', 'token_invalid', 'content_rejected', 'source_gone', 'superseded']);
export type OutboxDroppedReason = z.infer<typeof outboxDroppedReasonSchema>;

/**
 * What a client shows under an agent bubble of a platform chat (contracts changed): `pending` = on its way or being retried, `sent`, or `dropped` = it will
 * never arrive (`reason` says why). Absent for a bubble that is not delivered to a platform (a chat in the app).
 */
export const deliveryStateSchema = z.object({
  status: outboxStatusSchema,
  reason: outboxDroppedReasonSchema.optional(),
});
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

/** One outbound delivery as the owner sees it (`GET /v1/outbox`). Secrets and message text are never in it. */
export const outboxEntrySchema = z.object({
  id: idSchema,
  kind: outboxKindSchema,
  status: outboxStatusSchema,
  conversationId: idSchema.optional(),
  /** The item, question or document version being delivered. */
  sourceId: z.string().min(1),
  /** The platform ("telegram") for a chat delivery, "ios" / "android" for a push. */
  platform: z.string().min(1),
  attempts: z.number().int().min(0),
  /** When the next try is due (pending only). */
  nextAttemptAt: isoDateTimeSchema.optional(),
  /** One redacted line: what the last try said. */
  lastError: z.string().optional(),
  reason: outboxDroppedReasonSchema.optional(),
  createdAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.optional(),
  droppedAt: isoDateTimeSchema.optional(),
});
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

export const outboxQuerySchema = z.object({
  status: z.enum(['pending', 'dropped']).optional(),
  conversationId: idSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type OutboxQuery = z.infer<typeof outboxQuerySchema>;

/** A connected bot, app or push service that failed three tries in a row and has not delivered since (the `delivery` health entry, BACKEND 5.7.11). */
export const failingChannelSchema = z.object({
  platform: z.string().min(1),
  channelId: z.string().min(1),
  consecutiveFailures: z.number().int().min(3),
  lastError: z.string(),
  since: isoDateTimeSchema,
});
export type FailingChannel = z.infer<typeof failingChannelSchema>;

/**
 * `GET /v1/outbox`: `frozen` says why pending rows are not moving (the owner's switch, or the operator's `OUTBOX_FROZEN`); `health` is red while one of the
 * owner's channels is failing (restarts reset it; it turns red again after three more failed tries).
 */
export const outboxListSchema = z.object({
  items: z.array(outboxEntrySchema),
  nextCursor: z.string().optional(),
  frozen: z.object({ owner: z.boolean(), operator: z.boolean() }),
  health: z.object({ status: z.enum(['ok', 'red']), failing: z.array(failingChannelSchema) }),
});
export type OutboxList = z.infer<typeof outboxListSchema>;

export const outboxFreezeInputSchema = z.object({ frozen: z.boolean() });
export type OutboxFreezeInput = z.infer<typeof outboxFreezeInputSchema>;

export const outboxFreezeSchema = z.object({ frozen: z.boolean() });
export type OutboxFreeze = z.infer<typeof outboxFreezeSchema>;
