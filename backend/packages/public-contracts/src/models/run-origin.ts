import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/**
 * Who or what started a run. Written once when the run is created, from the wake that started it
 * (BACKEND "Run origin"). A child run's `origin` is `parent_run`; its `rootOrigin` is the origin of the
 * run at the top of the chain, which is what the audit's "started by" and "unattended" read.
 */
export const runOriginSchema = z.discriminatedUnion('type', [
  /** The owner typed in the app. */
  z.object({ type: z.literal('owner_message'), conversationId: idSchema, itemId: idSchema.optional() }),
  /** A message in a platform chat (Telegram, Slack, ...). `member` is reserved for a known non-owner; today the platforms report owner or stranger. */
  z.object({
    type: z.literal('channel'),
    channel: z.string().min(1),
    conversationId: idSchema,
    speaker: z.enum(['owner', 'member', 'stranger']),
  }),
  /** A routine's schedule or monitor fired. */
  z.object({ type: z.literal('routine'), routineId: idSchema, occurrenceAt: isoDateTimeSchema }),
  /** A child task: the run that spawned it. */
  z.object({ type: z.literal('parent_run'), runId: idSchema }),
  /** Anything else the system woke the agent for: task_done, onboarding, webhook, hand_back, a peer agent, a goal check-in... */
  z.object({ type: z.literal('system'), wakeKind: z.string().min(1), label: z.string().optional() }),
]);
export type RunOrigin = z.infer<typeof runOriginSchema>;
export type RunOriginType = RunOrigin['type'];
export const RUN_ORIGIN_TYPES: readonly RunOriginType[] = ['owner_message', 'channel', 'routine', 'parent_run', 'system'];

/**
 * Unattended = the root origin is neither the owner typing in the app nor the owner speaking in a platform chat:
 * routines, system wakes, strangers and members in channels, and the children of those.
 */
export function isUnattendedOrigin(root: RunOrigin): boolean {
  if (root.type === 'owner_message') return false;
  if (root.type === 'channel') return root.speaker !== 'owner';
  return true;
}
