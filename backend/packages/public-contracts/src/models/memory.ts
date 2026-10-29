import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const memoryScopeSchema = z.enum(['personal', 'team']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryTopicSchema = z.enum(['Preferences', 'People', 'Projects', 'Decisions']);
export type MemoryTopic = z.infer<typeof memoryTopicSchema>;

/** Legacy 2026-10-10 memory row. No longer served by the API (0.5.0): agentd migrates the rows into MEMORY.md and keeps the table unread. */
export const memorySchema = z.object({
  id: idSchema,
  scope: memoryScopeSchema,
  topic: memoryTopicSchema,
  /** Short slug the agent reads the entry by (e.g. "prefers-window-seat"); absent on rows written from the page. */
  name: z.string().min(1).optional(),
  /** One line the agent sees in its memory index, to decide whether the entry is worth reading. */
  description: z.string().optional(),
  text: z.string().min(1),
  /** Where it came from, e.g. "chat", "Gmail", "manual". */
  source: z.string().min(1),
  agentId: idSchema.optional(),
  tags: z.array(z.string()),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Memory = z.infer<typeof memorySchema>;

// ---------------------------------------------------------------------------
// Claims (BACKEND §5.2, §5.5): what the hourly job distilled from the user's messages, with the quote that proves it.
// ---------------------------------------------------------------------------

export const memoryClaimStatusSchema = z.enum(['active', 'superseded', 'retracted']);
export type MemoryClaimStatus = z.infer<typeof memoryClaimStatusSchema>;

/** The source of a claim: a message (`itemId` = an item of the user's conversations) or an agent's daily log (`log:<path>`), and the exact words taken from it. */
export const memoryEvidenceSchema = z.object({
  itemId: z.string().min(1),
  quote: z.string().min(1),
});
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>;

export const memoryClaimSchema = z.object({
  id: idSchema,
  text: z.string().min(1),
  evidence: z.array(memoryEvidenceSchema).min(1),
  /** 0..1, as the model judged it. */
  confidence: z.number().min(0).max(1),
  status: memoryClaimStatusSchema,
  /** The claim this one replaced (that one is `superseded`). */
  supersedesClaimId: idSchema.optional(),
  /** Where the claim was written when it was created; the line number drifts as the file is rewritten, the `[claim:<id>]` tag on the line is what counts. */
  target: z.object({ path: z.string().min(1), line: z.number().int().min(1).optional() }).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MemoryClaim = z.infer<typeof memoryClaimSchema>;

/** `GET /v1/memory/claims?status=` */
export const memoryClaimsResultSchema = z.object({ claims: z.array(memoryClaimSchema) });
export type MemoryClaimsResult = z.infer<typeof memoryClaimsResultSchema>;

/** `POST /v1/memory/forget`: retract these claims and remove every line that carries their tag. */
export const forgetMemoryInputSchema = z.object({ claimIds: z.array(idSchema).min(1).max(200) });
export type ForgetMemoryInput = z.infer<typeof forgetMemoryInputSchema>;
export const forgetMemoryResultSchema = z.object({
  /** Claims now `retracted` (ids that were already retracted or unknown are not counted). */
  retracted: z.number().int().min(0),
  /** Lines taken out of MEMORY.md, bank and people files. */
  removedLines: z.number().int().min(0),
});
export type ForgetMemoryResult = z.infer<typeof forgetMemoryResultSchema>;

/** `GET /v1/memory/search?q=`: the owner's memory items ranked for the query (memory items, not the files; batch 5a). */
export const memorySearchHitSchema = z.object({
  /** The item's id (`mem_…`), the tag `[mem:<id>]` a memory line carries. */
  id: z.string().min(1),
  text: z.string(),
  /** The view the item is shown in: `memory`, `bank:circumstances`, `bank:experiences`, `bank:preferences` or `person`. */
  file: z.string().min(1),
  score: z.number(),
});
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;
export const memorySearchResultSchema = z.object({ hits: z.array(memorySearchHitSchema) });
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;
