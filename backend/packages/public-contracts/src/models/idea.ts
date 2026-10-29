import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const ideaStatusSchema = z.enum(['open', 'accepted', 'dismissed']);
export type IdeaStatus = z.infer<typeof ideaStatusSchema>;

/** Work the daily ideas job did up front: a draft (a file under `drafts/` in the user's home) or an artifact. */
export const ideaPreparedSchema = z.object({
  kind: z.enum(['draft', 'artifact']),
  /** Home-relative path of the draft, or the artifact id. */
  ref: z.string().min(1),
  /** What to call it in the list. */
  label: z.string().optional(),
});
export type IdeaPrepared = z.infer<typeof ideaPreparedSchema>;

/** What accepting starts: a run of `agentId` in a conversation, with `prompt` as the first message. */
export const ideaActionSchema = z.object({ agentId: idSchema, prompt: z.string().min(1) });
export type IdeaAction = z.infer<typeof ideaActionSchema>;

/**
 * A next step offered to the user, by an agent while it works (`suggest`) or by the daily ideas job. `text` is the title and
 * `prompt` what accepting sends to `agentId`; accepting starts that run and records the conversation in `conversationId`.
 */
export const ideaSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  /** The one-sentence offer. */
  text: z.string().min(1),
  /** What the user would send if they accept. */
  prompt: z.string().min(1),
  status: ideaStatusSchema,
  /** One sentence naming what the idea rests on (a goal, a conversation, a memory line). Daily ideas only. */
  why: z.string().optional(),
  /** What accepting does, when it differs from `agentId` + `prompt`. */
  action: ideaActionSchema.optional(),
  prepared: ideaPreparedSchema.optional(),
  /** Short key of what the idea is about; a dismissed topic is not offered again for 14 days. */
  topic: z.string().optional(),
  /** Stable key of the idea (topic + what would be done), what dedupe compares instead of the wording. Daily ideas only. */
  key: z.string().optional(),
  /**
   * How a dismissed or accepted idea ended, for dedupe: `useful` (the owner tapped "useful"; the idea counts as handled),
   * `not_now` (snoozed 14 days with its topic) or `ignored` (open for 14 days without an answer). Absent for a plain dismiss or accept.
   */
  outcome: z.enum(['useful', 'not_now', 'ignored']).optional(),
  source: z.enum(['agent', 'daily']).optional(),
  /** Set when accepted: the conversation the run was started in. */
  conversationId: idSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Idea = z.infer<typeof ideaSchema>;
