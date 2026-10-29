import { z } from 'zod';
import { idSchema, isoDateSchema } from './common.js';
import { ideaSchema } from './idea.js';

/** What a proactive rule says: tell me about X, do not tell me about X, less of X, where and how to tell me. */
export const proactiveRuleKindSchema = z.enum(['tell', 'dont', 'less', 'where']);
export type ProactiveRuleKind = z.infer<typeof proactiveRuleKindSchema>;

/** What it is about: one topic, a type of message (a daily word, a news digest, goal check-ins), or how often. */
export const proactiveRuleScopeSchema = z.enum(['topic', 'type', 'frequency']);
export type ProactiveRuleScope = z.infer<typeof proactiveRuleScopeSchema>;

/**
 * One rule of the owner's proactive preferences (what the agent may message about unprompted). `strength` is set on `dont`
 * (`never`: hard, no expiry) and `less` (`less`: soft, `review` = created + 90 days); a soft rule past `review` has `dueForReview`
 * true: it still applies until the owner keeps (PATCH) or deletes it.
 */
export const proactiveRuleSchema = z.object({
  id: idSchema,
  kind: proactiveRuleKindSchema,
  scope: proactiveRuleScopeSchema,
  strength: z.enum(['never', 'less']).optional(),
  text: z.string().min(1),
  /** The owner's own words, or the button pressed and what it was pressed on. */
  source: z.string(),
  /** Local date (the owner's zone) the rule was made. */
  date: isoDateSchema,
  /** `less` rules only: the date the owner is asked to keep or drop it. */
  review: isoDateSchema.optional(),
  dueForReview: z.boolean(),
});
export type ProactiveRule = z.infer<typeof proactiveRuleSchema>;

export const proactiveFeedbackActionSchema = z.enum(['useful', 'not_now', 'less', 'never']);
export type ProactiveFeedbackAction = z.infer<typeof proactiveFeedbackActionSchema>;

/** The proactive item the buttons were pressed on: an idea, a message the agent sent on its own (a chat item id), or a feed post. */
export const proactiveFeedbackTargetSchema = z.object({ kind: z.enum(['idea', 'message', 'feed']), id: idSchema });
export type ProactiveFeedbackTarget = z.infer<typeof proactiveFeedbackTargetSchema>;

/** `scope` only matters for `less` / `never` (default `topic`): the rule is about this topic or about this type of message. */
export const proactiveFeedbackInputSchema = z.object({
  target: proactiveFeedbackTargetSchema,
  action: proactiveFeedbackActionSchema,
  scope: z.enum(['topic', 'type']).optional(),
});
export type ProactiveFeedbackInput = z.infer<typeof proactiveFeedbackInputSchema>;

/** `rule` is set when the action wrote one (`less`, `never`); `idea` is the updated idea when the target was one. */
export const proactiveFeedbackResultSchema = z.object({ rule: proactiveRuleSchema.optional(), idea: ideaSchema.optional() });
export type ProactiveFeedbackResult = z.infer<typeof proactiveFeedbackResultSchema>;

/** Keep a rule that is due for review: its review date moves 90 days on. The only edit; to change a rule, delete it. */
export const keepProactiveRuleInputSchema = z.object({ keep: z.literal(true) }).strict();
export type KeepProactiveRuleInput = z.infer<typeof keepProactiveRuleInputSchema>;
