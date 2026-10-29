import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const agentUsageSchema = z.object({
  agentId: idSchema,
  runs: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  computeSeconds: z.number().min(0),
  costUsd: z.number().min(0),
  /** PH11: false when any contributing run reported no real price, so costUsd 0 means unknown. */
  costKnown: z.boolean().optional(),
  /** PH11: false when any contributing run reported no usage at all, so token totals are unknown. */
  measured: z.boolean().optional(),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

export const appUsageSchema = z.object({
  app: z.string().min(1),
  runs: z.number().int().min(0),
  costUsd: z.number().min(0),
});
export type AppUsage = z.infer<typeof appUsageSchema>;

export const usageSchema = z.object({
  week: z.object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    computeSeconds: z.number().min(0),
    costUsd: z.number().min(0),
    /** PH11: false when any contributing run reported no real price. */
    costKnown: z.boolean().optional(),
    /** PH11: false when any contributing run reported no usage at all. */
    measured: z.boolean().optional(),
    limitUsd: z.number().min(0),
    /** 0..1 share of the included limit consumed. */
    percent: z.number().min(0),
  }),
  byAgent: z.array(agentUsageSchema),
  byApp: z.array(appUsageSchema),
});
export type Usage = z.infer<typeof usageSchema>;

/** One run's measured spend: the ledger row. Child runs carry the run that spawned them. */
export const usageLedgerEntrySchema = z.object({
  runId: idSchema,
  agentId: idSchema,
  conversationId: idSchema.optional(),
  parentRunId: idSchema.optional(),
  /** The model the run was frozen on; absent for runs recorded before the model was stored. */
  model: z.string().min(1).optional(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  /** False when no real price was reported, so costUsd 0 means unknown. */
  costKnown: z.boolean().optional(),
  /** False when the provider reported no usage at all, so the token counts are unknown. */
  measured: z.boolean().optional(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.optional(),
});
export type UsageLedgerEntry = z.infer<typeof usageLedgerEntrySchema>;

export const modelUsageSchema = z.object({
  /** "unknown" collects the runs that never recorded a model. */
  model: z.string().min(1),
  runs: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  costKnown: z.boolean().optional(),
  measured: z.boolean().optional(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

/** Paged ledger, newest run first. byModel totals every run matching the filter, not just this page. */
export const usageLedgerSchema = z.object({
  items: z.array(usageLedgerEntrySchema),
  nextCursor: z.string().nullable(),
  byModel: z.array(modelUsageSchema),
});
export type UsageLedger = z.infer<typeof usageLedgerSchema>;
