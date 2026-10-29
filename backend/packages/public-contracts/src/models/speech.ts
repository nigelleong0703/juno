import { z } from 'zod';

/** Longest text one `POST /v1/speech` speaks. */
export const SPEECH_MAX_CHARS = 2000;

/** `POST /v1/speech` (0.53.0): speak a reply. `lang` is detected from the script when absent (mixed text is spoken run by run). */
export const speechRequestSchema = z.object({
  text: z.string().trim().min(1).max(SPEECH_MAX_CHARS),
  lang: z.enum(['en', 'zh']).optional(),
});
export type SpeechRequest = z.infer<typeof speechRequestSchema>;

/**
 * Audio in sentence-sized parts, in playback order. `url` is relative to the API base and needs the same bearer token
 * (`GET` returns `audio/mp4`, or `audio/wav` when the server has no AAC encoder); it expires after about ten minutes.
 * Queue the urls (AVQueuePlayer) and start playing at once: the first part is ready when this answers, the others are made
 * in the background and a `GET` for one that is not ready waits for it (up to 20 s, then 504 `SPEECH_PENDING`; 502 `SPEECH_FAILED`
 * if making it failed). `durationMs` is present only for the part that is already made (the first).
 * 503 `SPEECH_UNAVAILABLE` means "speak on the device instead".
 */
export const speechResponseSchema = z.object({
  parts: z.array(z.object({ url: z.string().min(1), text: z.string(), durationMs: z.number().int().nonnegative().optional() })),
});
export type SpeechResponse = z.infer<typeof speechResponseSchema>;
