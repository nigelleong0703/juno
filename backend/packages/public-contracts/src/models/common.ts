import { z } from 'zod';

/** A non-empty opaque identifier for any entity. */
export const idSchema = z.string().min(1);
export type Id = z.infer<typeof idSchema>;

/** ISO-8601 timestamp with timezone (`2026-10-05T09:30:00.000Z`). */
export const isoDateTimeSchema = z.iso.datetime();
/** ISO-8601 calendar date (`2026-10-05`). */
export const isoDateSchema = z.iso.date();

// ---------------------------------------------------------------------------
// Status enums (ARCHITECTURE §2 "状态枚举集中定义")
// ---------------------------------------------------------------------------

/**
 * Derived, never stored (BACKEND §10.7). Precedence when several hold:
 * working > needs_you > paused > error > idle. `sleeping` is a legacy value no code path produces.
 */
export const agentStatusSchema = z.enum(['working', 'idle', 'sleeping', 'needs_you', 'paused', 'error']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const computerStateSchema = z.enum([
  'running',
  'paused',
  'asleep',
  'updating',
  'rebooting',
  'error',
]);
export type ComputerState = z.infer<typeof computerStateSchema>;

/** Task tabs (SPEC 4.5): In progress, Scheduled, Completed, Failed. */
export const runStatusSchema = z.enum([
  'scheduled',
  'queued',
  'running',
  'waiting_for_input',
  'completed',
  'failed',
  'stopped',
  'blocked',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const requestStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'answered',
  'expired',
]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/** `needs_setup`: a capability the routine declared (a connected app, web search) is missing; it does not run until the owner provides it. */
export const routineStatusSchema = z.enum(['active', 'paused', 'error', 'needs_setup']);
export type RoutineStatus = z.infer<typeof routineStatusSchema>;

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepKindSchema = z.enum(['computer', 'browser', 'shell', 'file', 'mcp', 'think']);
export type StepKind = z.infer<typeof stepKindSchema>;

/** Why a tool step failed: bad arguments, refused by policy or approval, an outside service, the 60s limit, the harness itself, anything else. */
export const stepErrorKindSchema = z.enum(['validation', 'permission', 'external', 'timeout', 'harness', 'other']);
export type StepErrorKind = z.infer<typeof stepErrorKindSchema>;

export const computerControllerSchema = z.enum(['agent', 'user']);
export type ComputerController = z.infer<typeof computerControllerSchema>;

// ---------------------------------------------------------------------------
// List / pagination envelope
// ---------------------------------------------------------------------------

export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** Generic list query accepted by every `*.list()` method. */
export const listParamsSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(0).optional(),
  sort: z.string().optional(),
  order: sortOrderSchema.optional(),
  search: z.string().optional(),
  /** Free-form equality filters; arrays mean "match any". */
  filter: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
});
export type ListParams = z.infer<typeof listParamsSchema>;

/** Cursor-paginated list response shape used by every `*.list()` method. */
export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

export const listResultSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
