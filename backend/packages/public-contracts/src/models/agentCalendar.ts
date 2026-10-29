import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const agentCalendarKindSchema = z.enum(['follow_up', 'meeting', 'task']);
export type AgentCalendarKind = z.infer<typeof agentCalendarKindSchema>;

export const agentCalendarStatusSchema = z.enum(['scheduled', 'done', 'missed', 'cancelled']);
export type AgentCalendarStatus = z.infer<typeof agentCalendarStatusSchema>;

/** Who a follow-up or meeting is with, and where to reach them. */
export const agentCalendarWithWhomSchema = z.object({
  name: z.string().min(1),
  channel: z.object({ kind: z.string().min(1), target: z.string().min(1) }).optional(),
});
export type AgentCalendarWithWhom = z.infer<typeof agentCalendarWithWhomSchema>;

/** Where a meeting the agent joins itself takes place. */
export const agentCalendarMeetingSchema = z.object({
  platform: z.enum(['discord', 'other']),
  channelId: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
});
export type AgentCalendarMeeting = z.infer<typeof agentCalendarMeetingSchema>;

/**
 * One entry in an agent's OWN calendar (not the owner's): a follow-up it promised, a meeting it joins itself, or a one-off
 * reminder or task. At `at` the agent is woken with `instructions` in `conversationId` (or its direct chat). Recurring
 * work stays a routine.
 */
export const agentCalendarItemSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  ownerId: idSchema,
  kind: agentCalendarKindSchema,
  title: z.string().min(1),
  at: isoDateTimeSchema,
  endAt: isoDateTimeSchema.optional(),
  /** IANA zone the agent meant `at` in (display only). */
  timezone: z.string().min(1),
  /** What to do when it is time. */
  instructions: z.string(),
  withWhom: agentCalendarWithWhomSchema.optional(),
  meeting: agentCalendarMeetingSchema.optional(),
  /** Where it came from and where to act. */
  conversationId: idSchema.optional(),
  status: agentCalendarStatusSchema,
  /** One line on how it went, set when it is done or missed. */
  result: z.string().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AgentCalendarItem = z.infer<typeof agentCalendarItemSchema>;

/** The owner may retitle, move, rewrite or cancel an item; nothing else. */
export const updateAgentCalendarItemSchema = z.object({
  title: z.string().min(1).optional(),
  at: isoDateTimeSchema.optional(),
  endAt: isoDateTimeSchema.optional(),
  instructions: z.string().optional(),
  status: z.literal('cancelled').optional(),
}).strict();
export type UpdateAgentCalendarItem = z.infer<typeof updateAgentCalendarItemSchema>;
