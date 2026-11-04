import { z } from 'zod';

/** A short-lived, room-scoped credential for one in-app voice call. */
export const voiceCallSessionSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  participantIdentity: z.string().min(1),
});
export type VoiceCallSession = z.infer<typeof voiceCallSessionSchema>;
