/**
 * Busy-mode decisions and inbox draining (BACKEND §3.2). Pure functions — the Session object is a thin
 * Restate adapter over these.
 */
import { LIMITS, type BusyMode, type WakeEvent, type WakeKind } from '../../../contracts/index.js';
import type { RunKind } from '@agent-desktop/public-contracts';

export interface QueuedEvent {
  event: WakeEvent;
  mode: BusyMode;
  /** Monotonic arrival order inside the session (stable tie-breaker). */
  seq: number;
  /** Interrupting events jump the queue. */
  urgent?: boolean;
  /** A note for the model's context, never a reason to run (screen control notices): it rides into the next run or steer. */
  contextOnly?: boolean;
}

const DEFAULT_MODE: Partial<Record<WakeKind, BusyMode>> = {
  user_message: 'steer',
  room_mention: 'collect',
  connector_event: 'collect',
  // Background completions reach a running parent at its next tool boundary; an idle one starts a run.
  task_done: 'steer',
  hand_back: 'steer',
  timer: 'steer',
};

/** event.mode ?? default by kind (user → steer; room/connector → collect; else followup). */
export function resolveBusyMode(event: Pick<WakeEvent, 'kind' | 'mode'>): BusyMode {
  return event.mode ?? DEFAULT_MODE[event.kind] ?? 'followup';
}

export const priorityRank = (p: WakeEvent['priority']): number => (p === 'user' ? 0 : p === 'peer' ? 1 : 2);

/** Highest priority first; urgent (interrupt) before anything; then arrival order. */
export function sortInbox(inbox: readonly QueuedEvent[]): QueuedEvent[] {
  return [...inbox].sort(
    (a, b) =>
      Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) ||
      priorityRank(a.event.priority) - priorityRank(b.event.priority) ||
      a.seq - b.seq,
  );
}

/**
 * Pick the events for the next run. A `collect` head merges with every other collect event of the same
 * priority and trust level (senders with different permissions never share a turn), capped at
 * collectMaxEvents. Anything else runs alone.
 */
export function selectNextBatch(
  inbox: readonly QueuedEvent[],
  maxCollect: number = LIMITS.session.collectMaxEvents,
): { batch: QueuedEvent[]; rest: QueuedEvent[] } {
  // Context-only notes never head a batch (the run's kind, title and routine-ness come from its first wake):
  // with nothing else queued no run starts; otherwise they follow the real wakes into the next run.
  const notes = inbox.filter((q) => q.contextOnly).sort((a, b) => a.seq - b.seq);
  if (notes.length > 0) {
    const picked = selectNextBatch(inbox.filter((q) => !q.contextOnly), maxCollect);
    if (picked.batch.length === 0) return { batch: [], rest: notes };
    return { batch: [...picked.batch, ...notes], rest: picked.rest };
  }
  const sorted = sortInbox(inbox);
  const head = sorted[0];
  if (!head) return { batch: [], rest: [] };
  if (head.mode !== 'collect' || head.urgent) {
    return { batch: [head], rest: sorted.slice(1).sort((a, b) => a.seq - b.seq) };
  }
  const batch: QueuedEvent[] = [];
  const rest: QueuedEvent[] = [];
  for (const q of sorted) {
    if (
      batch.length < maxCollect &&
      q.mode === 'collect' &&
      !q.urgent &&
      q.event.priority === head.event.priority &&
      q.event.trusted === head.event.trusted
    ) {
      batch.push(q);
    } else rest.push(q);
  }
  batch.sort((a, b) => a.seq - b.seq);
  rest.sort((a, b) => a.seq - b.seq);
  return { batch, rest };
}

/** Steer point: take every pending `steer` event (priority order), leave the rest queued. */
export function takeSteerEvents(inbox: readonly QueuedEvent[]): { steer: QueuedEvent[]; rest: QueuedEvent[] } {
  const steer = sortInbox(inbox.filter((q) => q.mode === 'steer' && !q.urgent));
  const rest = inbox.filter((q) => !(q.mode === 'steer' && !q.urgent));
  return { steer, rest };
}

/** Run kind from the wake that started it. */
export function runKindFor(kind: WakeKind): RunKind {
  if (kind === 'user_message' || kind === 'room_mention' || kind === 'agent_message' || kind === 'request_resolved' || kind === 'hand_back' || kind === 'private_handoff') return 'chat';
  if (kind === 'routine' || kind === 'monitor') return 'routine';
  return 'background';
}

/**
 * Human run title from the first wake event. `taskTitle` is the title of the work a completion wake reports on (the child
 * run or background task, looked up by run-engine): a completion run is named after that task, never after the raw result,
 * which can be a file path or a page of text.
 */
export function runTitleFor(events: readonly WakeEvent[], taskTitle?: string): string {
  const first = events[0];
  if (!first) return 'New task';
  const p = first.payload;
  const text = [p.text, p.title, p.prompt, p.reason, p.message].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const label = first.origin.label;
  let title: string;
  switch (first.kind) {
    case 'routine':
      title = `Routine: ${typeof p.routineName === 'string' ? p.routineName : (label ?? text ?? 'scheduled run')}`;
      break;
    case 'monitor':
      title = `Monitor: ${typeof p.routineName === 'string' ? p.routineName : 'watch'}`;
      break;
    case 'goal_checkin':
      title = `Goal: ${typeof p.title === 'string' ? p.title : 'check-in'}`;
      break;
    case 'calendar_due':
      title = `Calendar: ${typeof p.title === 'string' ? p.title : 'due item'}`;
      break;
    case 'capability_ready':
    case 'capability_lost':
      title = `Routine ${first.kind === 'capability_ready' ? 'ready' : 'on hold'}: ${typeof p.connector === 'string' ? p.connector : 'app'}`;
      break;
    case 'private_handoff':
      title = `Private question from ${typeof p.sourceChat === 'string' ? p.sourceChat : 'a group'}`;
      break;
    case 'timer':
      title = `Woke up: ${text ?? 'timer'}`;
      break;
    case 'connector_event':
    case 'webhook':
      title = `Event: ${text ?? (typeof p.type === 'string' ? p.type : first.kind)}`;
      break;
    case 'agent_message':
      title = `Message from ${label ?? 'agent'}${text ? `: ${text}` : ''}`;
      break;
    case 'task_done':
      title = taskTitle === undefined ? 'Wrapping up a task' : `Wrapping up: ${taskTitle}`;
      break;
    case 'hand_back':
      if (p['source'] === 'screen_control') title = 'Screen handed back';
      else if (p['source'] === 'discord_voice') title = 'Voice call ended';
      else if (p['source'] === 'meeting') title = 'Meeting ended';
      else title = taskTitle === undefined ? 'Update from a child task' : `Update on: ${taskTitle}`;
      break;
    case 'onboarding':
      title = 'Getting started';
      break;
    case 'room_mention':
      // The @mentions address the room, they are not the task.
      title = text?.replace(/(^|\s)@[\p{L}\p{N}_-]+/gu, ' ') ?? '';
      break;
    default:
      title = text ?? 'New task';
  }
  title = title.replace(/\s+/g, ' ').trim();
  return title.length > 72 ? `${title.slice(0, 71)}…` : title || 'New task';
}
