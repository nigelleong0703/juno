/**
 * Typed request/response schemas for the sandbox-local Google Meet helper (`agent-meet`).
 * Pure seam: no helper paths or commands (those live in sandbox-adapters/meet.ts).
 */
import { z } from 'zod';

export const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(\?.*)?$/;

export const meetInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('join'), url: z.string().regex(MEET_URL, 'a https://meet.google.com/<code> URL'), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('chat_read'), since: z.string().min(1).max(200).optional(), name: z.string().trim().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal('chat_send'), text: z.string().trim().min(1).max(4000) }).strict(),
  /** The meeting's audio since a segment seq (same epoch); segments up to `since` are dropped from the page. */
  z.object({ action: z.literal('audio_read'), since: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('leave') }).strict(),
]);
export type MeetInput = z.infer<typeof meetInputSchema>;

export const meetStateSchema = z.enum(['waiting_admission', 'in_meeting', 'denied', 'captcha', 'error', 'ended', 'prejoin', 'unknown']);
export type MeetState = z.infer<typeof meetStateSchema>;

export const meetChatMessageSchema = z.object({
  id: z.string().min(1),
  sender: z.string(),
  text: z.string(),
  at: z.string().optional(),
  /** True for the agent's own messages (the helper matches the sender against the `name` of chat_read). */
  self: z.boolean().optional(),
});
export type MeetChatMessage = z.infer<typeof meetChatMessageSchema>;

export const meetResultSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('join'), state: meetStateSchema, detail: z.string() }),
  z.object({ action: z.literal('state'), state: meetStateSchema, detail: z.string(), participants: z.number().int().nonnegative().optional() }),
  z.object({ action: z.literal('chat_read'), messages: z.array(meetChatMessageSchema), raw: z.string().optional() }),
  z.object({ action: z.literal('chat_send'), sent: z.literal(true) }),
  z.object({
    action: z.literal('audio_read'),
    /** The page recorder hears at least one remote audio track. */
    on: z.boolean(),
    /** Random id of the page-side recorder; a Meet reload starts a new one and its segment seqs restart at 1. */
    epoch: z.string().optional(),
    /** Standalone webm/opus files cut at pauses (base64), oldest first, with the names Meet showed as speaking meanwhile. */
    segments: z.array(z.object({ seq: z.number().int(), start: z.string(), end: z.string(), speakers: z.array(z.string()), data: z.string() })),
  }),
  z.object({ action: z.literal('leave'), state: meetStateSchema, detail: z.string() }),
]);
export type MeetResult = z.infer<typeof meetResultSchema>;
