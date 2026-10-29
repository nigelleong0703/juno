import { z } from 'zod';
import { idSchema, isoDateTimeSchema, routineStatusSchema } from './common.js';

// --- Triggers ---------------------------------------------------------------

export const scheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  /** Standard cron expression when known. */
  cron: z.string().optional(),
  /** Human phrasing, e.g. "Weekdays 9:00 (Asia/Singapore)". */
  human: z.string().min(1),
  tz: z.string().min(1),
  endDate: z.iso.date().optional(),
});

export const eventSourceSchema = z.enum(['github', 'slack', 'email', 'mcp']);
export type RoutineEventSource = z.infer<typeof eventSourceSchema>;

export const eventTriggerSchema = z.object({
  kind: z.literal('event'),
  source: eventSourceSchema,
  /** e.g. "New PR in acme/agent-desktop". */
  filter: z.string().min(1),
});

export const webhookTriggerSchema = z.object({
  kind: z.literal('webhook'),
  url: z.string().min(1),
  /** Always masked in the UI (`whsec_••••`). */
  secretMasked: z.string(),
});

/**
 * A monitor: the agent's own watch. Every `everyMinutes` the server makes one read-only tool call (`tool` with `args`:
 * a connector read tool or web_fetch) and the agent is woken only when something new matches.
 * List result: `items` is the dot path to the list inside the result ("" for a bare list) and `id` the field that
 * identifies an item. Page text (no `items`): `pattern` is a regex the page must match and `below` a number the first
 * capture group must be under ("price under X").
 */
export const checkTriggerSchema = z.object({
  kind: z.literal('check'),
  everyMinutes: z.number().positive(),
  /** Human phrasing, e.g. "Every 30 minutes". */
  human: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  items: z.string().optional(),
  id: z.string().optional(),
  pattern: z.string().optional(),
  below: z.number().optional(),
});
export type CheckTrigger = z.infer<typeof checkTriggerSchema>;

export const routineTriggerSchema = z.discriminatedUnion('kind', [
  scheduleTriggerSchema,
  eventTriggerSchema,
  webhookTriggerSchema,
  checkTriggerSchema,
]);
export type RoutineTrigger = z.infer<typeof routineTriggerSchema>;

// --- Delivery + notify ------------------------------------------------------

export const deliverySchema = z.object({
  channel: z.enum(['chat', 'slack', 'email']),
  /** e.g. "#research" or the email address. */
  target: z.string().optional(),
});
export type Delivery = z.infer<typeof deliverySchema>;

export const notifyRuleSchema = z.object({
  mode: z.enum(['always', 'on_failure', 'never']),
  channel: z.enum(['desktop', 'email', 'slack']).optional(),
});
export type NotifyRule = z.infer<typeof notifyRuleSchema>;

// --- Run history ------------------------------------------------------------

export const routineRunSchema = z.object({
  id: idSchema,
  routineId: idSchema,
  /** `skipped`: occurrences that came due while the server was offline and were not run (the summary says how many and when). Never the routine's `lastRunStatus`. */
  status: z.enum(['running', 'completed', 'failed', 'skipped']),
  summary: z.string(),
  /** Link to the Run this routine run produced. */
  runId: idSchema.optional(),
  outputRef: idSchema.optional(),
  /** Visible output item ids this run produced (bounded); the read-evidence source. */
  outputIds: z.array(idSchema).optional(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
});
export type RoutineRun = z.infer<typeof routineRunSchema>;

// --- Capability gate --------------------------------------------------------

/** The non-connector capabilities a requirement can name; every other option is a connector catalog id. `mac` is the owner's paired Mac (Mail, Calendar, Reminders). */
export const PLATFORM_CAPABILITIES = ['web_search', 'computer', 'mac'] as const;

/**
 * What a routine needs to run, as an any-of set: `capability` names the need ("calendar", "mail", "web_search", "computer",
 * or a connector id), `options` are the things that satisfy it (connector catalog ids such as `google-calendar`, or
 * `web_search` / `computer` / `mac`). One option is enough.
 */
export const routineRequirementSchema = z.object({
  capability: z.string().min(1).max(40),
  options: z.array(z.string().min(1).max(60)).min(1).max(8),
});
export type RoutineRequirement = z.infer<typeof routineRequirementSchema>;

/** A requirement the owner does not meet yet; `label` is the human name of the options ("Google Calendar or Outlook"). */
export const routineMissingSchema = routineRequirementSchema.extend({ label: z.string().min(1).max(160) });
export type RoutineMissing = z.infer<typeof routineMissingSchema>;

/** What a monitor shows in the routine list: when it last looked, when it last found something, and why it stopped. */
export const monitorViewSchema = z.object({
  /** After this the monitor stops and the agent asks whether to renew it. */
  expiresAt: isoDateTimeSchema,
  lastCheckedAt: isoDateTimeSchema.optional(),
  lastMatchAt: isoDateTimeSchema.optional(),
  /** Checks that failed in a row (0 after a good one). */
  failures: z.number().int().min(0),
  lastError: z.string().optional(),
  /** The connector the check uses needs the owner to sign in again. */
  needsReconnect: z.boolean().optional(),
  /** Set when the monitor turned itself off. */
  stoppedReason: z.enum(['expired', 'failures', 'reconnect']).optional(),
});
export type MonitorView = z.infer<typeof monitorViewSchema>;

export const routineSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  name: z.string().min(1),
  instructions: z.string(),
  trigger: routineTriggerSchema,
  delivery: deliverySchema,
  notify: notifyRuleSchema,
  enabled: z.boolean(),
  status: routineStatusSchema,
  /** What the task needs (declared when it was created); checked against what the owner has connected. Absent = nothing. */
  requires: z.array(routineRequirementSchema).max(8).optional(),
  /** Set while `status` is `needs_setup`: the requirements not met yet. Clients show a Connect action per catalog id. */
  missing: z.array(routineMissingSchema).optional(),
  /** Present on a routine with a `check` trigger (an agent-created monitor). */
  monitor: monitorViewSchema.optional(),
  lastRunAt: isoDateTimeSchema.optional(),
  /** Last authorized read cutoff over the delivery chat; absent when never read. */
  lastReadAt: isoDateTimeSchema.optional(),
  lastRunStatus: z.enum(['completed', 'failed']).optional(),
  nextRunAt: isoDateTimeSchema.optional(),
  runs: z.array(routineRunSchema),
  createdAt: isoDateTimeSchema,
});
export type Routine = z.infer<typeof routineSchema>;

export const createRoutineInputSchema = routineSchema
  .omit({ id: true, runs: true, createdAt: true, missing: true, monitor: true, lastRunAt: true, lastRunStatus: true, nextRunAt: true })
  .partial()
  .extend({
    name: z.string().min(1),
    agentId: idSchema,
    trigger: routineTriggerSchema,
  });
export type CreateRoutineInput = z.infer<typeof createRoutineInputSchema>;

export const updateRoutineInputSchema = createRoutineInputSchema.partial().extend({
  enabled: z.boolean().optional(),
  status: routineStatusSchema.optional(),
});
export type UpdateRoutineInput = z.infer<typeof updateRoutineInputSchema>;
