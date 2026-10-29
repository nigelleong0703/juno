import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { decisionCategorySchema, delegationLimitsSchema } from './decision.js';

export const ruleScopeSchema = z.enum(['app', 'action', 'recipient', 'site', 'delegation']);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** Four levels (SPEC 4.7): Act without asking · Act when I say so · Ask first · Hand off to me. */
export const ruleBehaviorSchema = z.enum(['auto', 'on_command', 'ask', 'handoff']);
export type RuleBehavior = z.infer<typeof ruleBehaviorSchema>;

export const ruleSourceSchema = z.enum(['builtin', 'team', 'user', 'agent_draft']);
export type RuleSource = z.infer<typeof ruleSourceSchema>;

export const ruleSchema = z.object({
  id: idSchema,
  description: z.string().min(1),
  scope: ruleScopeSchema,
  behavior: ruleBehaviorSchema,
  source: ruleSourceSchema,
  enabled: z.boolean(),
  /** Concrete subject the rule matches, e.g. app "Gmail", action "purchase", site "linear.app". */
  subject: z.string().optional(),
  /** Set: the rule applies to this agent only (e.g. "Always allow" from an approval card). Unset: every agent of the owner. */
  agentId: idSchema.optional(),
  createdAt: isoDateTimeSchema,
  createdBy: idSchema.optional(),
  /** For `source: 'agent_draft'` — the run that proposed it. */
  draftedByRunId: idSchema.optional(),
  /** For drafts: why the agent suggests this rule. */
  rationale: z.string().optional(),
  /** `scope: 'delegation'` (0.22.0): what the agent may decide alone. Created through `/v1/delegations`, never `/v1/rules`. */
  delegation: z
    .object({
      category: decisionCategorySchema,
      /** `app:<catalogId>`, `site:<host>`, `chat:<conversationId>` (sharing) or `juno`. */
      platformKey: z.string().min(1),
      /** Only in this routine's runs. */
      routineId: idSchema.optional(),
      limits: delegationLimitsSchema,
    })
    .optional(),
  /** Delegations: after this the rule stays but no longer matches ("expired, renew"). */
  expiresAt: isoDateTimeSchema.optional(),
  lastUsedAt: isoDateTimeSchema.optional(),
  useCount: z.number().int().min(0).optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const createRuleInputSchema = ruleSchema.omit({
  id: true,
  createdAt: true,
  source: true,
  draftedByRunId: true,
  rationale: true,
  // Delegations are made through `/v1/delegations`, which checks their limits; the rule routes never write these.
  delegation: true,
  expiresAt: true,
  lastUsedAt: true,
  useCount: true,
});
export type CreateRuleInput = z.infer<typeof createRuleInputSchema>;

export const updateRuleInputSchema = createRuleInputSchema.partial();
export type UpdateRuleInput = z.infer<typeof updateRuleInputSchema>;
