/**
 * Service definitions with proper type information for SendClient typing.
 * These are placeholder definitions that carry type information.
 */

import type { VirtualObjectDefinition, WorkflowDefinition, ObjectContext, ObjectSharedContext, WorkflowContext, WorkflowSharedContext } from '@agent-desktop/durable';
import type { Routine } from '@agent-desktop/public-contracts';
import type { WakeEvent, TaskWatchStart } from '../../../contracts/index.js';
import type { RunInput } from './run-types.js';
import type { SessionState, TypingState } from './session.js';
import type { DigestTarget } from '../../../modules/digest/job.js';

// Define the handler types for each service
export interface RoutineTimerHandlers {
  arm: (ctx: ObjectContext, routine: Routine) => Promise<void>;
  fire: (ctx: ObjectContext, params: { at: string; routineId: string; generation: number }) => Promise<void>;
  checkNow: (ctx: ObjectContext) => Promise<{ outcome: string }>;
  recordCompletion: (ctx: ObjectContext, params: { routineId: string; runId?: string; occurrenceAt?: string; succeeded: boolean; itemsGenerated: number; outputIds?: string[]; summary?: string }) => Promise<void>;
  recordRead: (ctx: ObjectContext, params: { routineId: string; conversationId: string; readCutoff: string; resultIds: string[] }) => Promise<void>;
}

export interface SessionHandlers {
  receive: (ctx: ObjectContext, event: WakeEvent) => Promise<{ accepted: boolean; reason?: string }>;
  flush: (ctx: ObjectContext, token: string) => Promise<void>;
  drainInbox: (ctx: ObjectContext) => Promise<WakeEvent[]>;
  runFinished: (ctx: ObjectContext, runId: string) => Promise<void>;
  typingState: (ctx: ObjectSharedContext) => Promise<TypingState>;
  idleCompact: (ctx: ObjectContext, token: string) => Promise<void>;
  runNow: (ctx: ObjectContext) => Promise<{ outcome: string }>;
  getState: (ctx: ObjectContext) => Promise<SessionState>;
}

export type { RunInput };

export interface RunHandlers {
  run: (ctx: WorkflowContext, input: RunInput) => Promise<void>;
  cancel: (ctx: WorkflowSharedContext) => Promise<void>;
}

// Create definition objects with proper types
export const routineTimerDef: VirtualObjectDefinition<'RoutineTimer', RoutineTimerHandlers> = {
  name: 'RoutineTimer',
};

/** `nightly` runs the night's memory jobs; `goals` starts the goal check-ins that are due; `briefing` writes the daily goal briefing. `at` replaces the clock (tests, operators). */
export type MemoryJobName = 'nightly' | 'goals' | 'briefing';

export interface MemoryTimerHandlers {
  arm: (ctx: ObjectContext) => Promise<void>;
  fire: (ctx: ObjectContext, params: { generation: number }) => Promise<void>;
  runNow: (ctx: ObjectContext, params: { job: MemoryJobName; at?: string }) => Promise<{ outcome: string }>;
}

export interface CalendarTimerHandlers {
  arm: (ctx: ObjectContext) => Promise<void>;
  fire: (ctx: ObjectContext, params: { generation: number }) => Promise<void>;
}

export interface IdeasTimerHandlers {
  arm: (ctx: ObjectContext) => Promise<void>;
  fire: (ctx: ObjectContext, params: { generation: number }) => Promise<void>;
  runNow: (ctx: ObjectContext, params?: { force?: boolean }) => Promise<{ outcome: string }>;
}

export interface ChatDigestHandlers {
  touch: (ctx: ObjectContext, target: DigestTarget) => Promise<void>;
  fire: (ctx: ObjectContext, params: { generation: number }) => Promise<void>;
  runNow: (ctx: ObjectContext, params?: DigestTarget) => Promise<{ outcome: string }>;
}

export interface TaskWatcherHandlers {
  watch: (ctx: ObjectContext, input: TaskWatchStart) => Promise<void>;
}

/** One hidden schedule per user (key = ownerId) that runs the hourly and nightly memory jobs (BACKEND §5.4). */
export const memoryTimerDef: VirtualObjectDefinition<'MemoryTimer', MemoryTimerHandlers> = {
  name: 'MemoryTimer',
};

/** One per item of an agent's own calendar (key = item id): wakes the agent when it is due. */
export const calendarTimerDef: VirtualObjectDefinition<'CalendarTimer', CalendarTimerHandlers> = {
  name: 'CalendarTimer',
};

/** One hidden schedule per user (key = ownerId) that runs the daily ideas job (BACKEND §5.10). */
export const ideasTimerDef: VirtualObjectDefinition<'IdeasTimer', IdeasTimerHandlers> = {
  name: 'IdeasTimer',
};

/** One per conversation (key = conversation id) that runs the chat digest after the chat has been quiet (BACKEND §5.4, §5.7.9, §5.10). */
export const chatDigestDef: VirtualObjectDefinition<'ChatDigest', ChatDigestHandlers> = {
  name: 'ChatDigest',
};

export const taskWatcherDef: VirtualObjectDefinition<'TaskWatcher', TaskWatcherHandlers> = {
  name: 'TaskWatcher',
};

export const sessionDef: VirtualObjectDefinition<'Session', SessionHandlers> = {
  name: 'Session',
};

export const runDef: WorkflowDefinition<'Run', RunHandlers> = {
  name: 'Run',
};

// Export types for use in services
export type RoutineTimerDef = typeof routineTimerDef;
export type SessionDef = typeof sessionDef;
export type RunDef = typeof runDef;
export type ChatDigestDef = typeof chatDigestDef;
