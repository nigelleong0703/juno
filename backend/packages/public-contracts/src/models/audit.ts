import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { decisionCategorySchema } from './decision.js';
import { runOriginSchema } from './run-origin.js';

export const auditDecisionSchema = z.enum([
  'auto_allowed',
  'asked',
  'approved',
  'denied',
  'handed_off',
  'timed_out',
  'revised',
]);
export type AuditDecision = z.infer<typeof auditDecisionSchema>;

export const auditEntrySchema = z.object({
  id: idSchema,
  at: isoDateTimeSchema,
  actor: z.enum(['agent', 'user', 'system']),
  agentId: idSchema.optional(),
  memberId: idSchema.optional(),
  /** What was reviewed, e.g. "Send email to team@example.com". */
  action: z.string().min(1),
  target: z.string().optional(),
  decision: auditDecisionSchema,
  /** Human-readable reason / rule that drove the decision. */
  reason: z.string().min(1),
  ruleId: idSchema.optional(),
  requestId: idSchema.optional(),
  runId: idSchema.optional(),
  /** 0.22.0: what the decision was about (approval rows). */
  brief: z.object({ categories: z.array(decisionCategorySchema), sentence: z.string(), factsHash: z.string() }).optional(),
  /**
   * 0.68.0: who started the work, i.e. the root origin of the run the entry belongs to (the top of the chain for a child run).
   * An entry without a run (a system action such as a home-files repair) is `{ type: 'system' }`.
   */
  initiator: runOriginSchema,
  /** 0.68.0: true when `initiator` is not the owner (see `isUnattendedOrigin`): routines, system wakes, strangers and members in channels. */
  unattended: z.boolean(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
