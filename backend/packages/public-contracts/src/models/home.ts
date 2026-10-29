import { z } from 'zod';
import { isoDateTimeSchema } from './common.js';

/** One file of the agent's home as the mirror holds it. `hash` is the sha256 of `content`; send it back as `expectedHash` to detect a concurrent change. */
export const agentHomeFileSchema = z.object({
  /** Relative to the user's `/juno`, e.g. `agents/<agentId>/SOUL.md` or `USER.md`. */
  path: z.string().min(1),
  content: z.string(),
  hash: z.string().min(1),
  writer: z.enum(['user', 'agent', 'platform']),
  updatedAt: isoDateTimeSchema,
});
export type AgentHomeFile = z.infer<typeof agentHomeFileSchema>;

export const writeHomeFileInputSchema = z.object({
  content: z.string(),
  expectedHash: z.string().min(1).optional(),
});
export type WriteHomeFileInput = z.infer<typeof writeHomeFileInputSchema>;
