/**
 * Run origin (BACKEND "Run origin"): what started a run, derived once from the wake that started it. The audit's
 * "started by" and "unattended" read the ROOT origin of the chain, so a child task of a routine is unattended too.
 */
import { isUnattendedOrigin, type AuditEntry, type Run, type RunOrigin } from '@agent-desktop/public-contracts';
import { COMPLETION_WAKE_KINDS, type Store, type WakeEvent } from '../../../contracts/index.js';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** The origin of a run started by `wake` in `conversationId`; no wake is the owner typing in the app, like `runKindFor`. */
export function originOfWake(conversationId: string, wake: WakeEvent | undefined): RunOrigin {
  if (wake === undefined) return { type: 'owner_message', conversationId };
  const system = (): RunOrigin => ({ type: 'system', wakeKind: wake.kind, ...(wake.origin.label === undefined ? {} : { label: wake.origin.label }) });
  switch (wake.kind) {
    case 'subagent_task': {
      const runId = text(wake.payload['parentRunId']);
      return runId === undefined ? system() : { type: 'parent_run', runId };
    }
    case 'routine':
    case 'monitor':
    case 'webhook': {
      // A webhook is a routine's only when an automation sent it (a manual /wake is the owner's).
      const routineId = text(wake.payload['routineId']) ?? (wake.origin.type === 'automation' ? wake.origin.id : undefined);
      if (routineId === undefined) return system();
      return { type: 'routine', routineId, occurrenceAt: text(wake.payload['occurrenceAt']) ?? wake.at };
    }
    case 'user_message':
    case 'room_mention': {
      if (wake.origin.type !== 'user') return system();
      const channel = text(wake.payload['channelKind']);
      if (channel !== undefined) {
        const speaker = wake.payload['speakerRole'] === 'owner' ? 'owner' : wake.payload['teammate'] === true ? 'member' : 'stranger';
        const name = text(wake.payload['speakerName']);
        return { type: 'channel', channel, conversationId, speaker, ...(name === undefined ? {} : { speakerName: name.slice(0, 80) }) };
      }
      const itemId = text(wake.payload['itemId']);
      return { type: 'owner_message', conversationId, ...(itemId === undefined ? {} : { itemId }) };
    }
    default:
      return system();
  }
}

/**
 * A child run's root: the parent's own root, or the parent's origin when it is the top of the chain. A parent that is gone reads as
 * system (unattended). A completion wake (a child's result, its report, a timer) continues the work of the run that started it
 * (`originRunId`), so that run's root is this run's root too: the wrap-up after a task the owner asked for is not unattended.
 */
export async function rootOriginOf(store: Store, origin: RunOrigin, wake?: WakeEvent): Promise<RunOrigin | undefined> {
  if (origin.type === 'parent_run') {
    const parent = await store.get('runs', origin.runId);
    return parent?.rootOrigin ?? parent?.origin ?? { type: 'system', wakeKind: 'subagent_task', label: 'parent run not found' };
  }
  const originRunId = wake !== undefined && COMPLETION_WAKE_KINDS.includes(wake.kind) ? text(wake.payload['originRunId']) : undefined;
  if (originRunId === undefined) return undefined;
  const started = await store.get('runs', originRunId);
  return started === null ? undefined : started.rootOrigin ?? started.origin;
}

/** The root origin of a run, as the audit reads it. */
export function runInitiator(run: Pick<Run, 'origin' | 'rootOrigin'>): RunOrigin | undefined {
  return run.rootOrigin ?? run.origin;
}

/**
 * Whether a wake that STARTS a work chain is one where nobody waits (BACKEND §3.3b): an allowlist, so anything unknown fails closed.
 * Scheduled routine fire, monitor fire (not its system notice), an automation-sent webhook, the scheduled goal check-in (reason
 * `scheduled`, never the manual "Check now") and the daily proactive check (reason `proactive`). Onboarding, peer-agent messages, room
 * mentions, request_resolved, the plan and deadline check-ins and every other kind are not in it. Completion wakes and child tasks are
 * decided from the run they continue (`nobodyWaitingOf`).
 */
export function isUnattendedStartWake(wake: WakeEvent): boolean {
  switch (wake.kind) {
    case 'routine': return wake.origin.type === 'automation' && text(wake.payload['routineId']) !== undefined;
    case 'monitor': return wake.payload['notice'] !== true && text(wake.payload['routineId']) !== undefined;
    case 'webhook': return wake.origin.type === 'automation' && text(wake.payload['routineId'] ?? wake.origin.id) !== undefined;
    case 'goal_checkin': return wake.origin.type === 'automation' && (wake.payload['reason'] === 'scheduled' || wake.payload['reason'] === 'proactive');
    // The outbox telling the agent a message never arrived (BACKEND 5.7.11): nobody asked for it, so it speaks only through send_message.
    case 'hand_back': return wake.origin.type === 'system' && wake.payload['source'] === 'delivery_failed';
    default: return false;
  }
}

/**
 * The `nobodyWaiting` mark of a new run, written once with its origin: its own starting wake is on the allowlist, or it continues a run
 * that was (a child task of it, or a task_done / hand_back / timer wake naming the run that started the work). No wake: false.
 */
export async function nobodyWaitingOf(store: Store, wake: WakeEvent | undefined): Promise<boolean> {
  if (wake === undefined) return false;
  const continued = wake.kind === 'subagent_task' ? text(wake.payload['parentRunId']) : COMPLETION_WAKE_KINDS.includes(wake.kind) ? text(wake.payload['originRunId']) : undefined;
  if (continued === undefined) return isUnattendedStartWake(wake);
  return (await store.get('runs', continued))?.nobodyWaiting === true;
}

/**
 * Whether a run speaks only through send_message / feed_post (BACKEND §3.3b): it was marked nobody-waiting when it started, and its root
 * is unattended and not a platform chat. Its final text is then a record line, never a message. This is the one classification the wake
 * note, the final reply, the task list and send_message's purpose check all read; a run without the mark (an old row) is not one.
 */
export function speaksOnlyBySend(run: (Pick<Run, 'origin' | 'rootOrigin'> & { nobodyWaiting?: boolean }) | null | undefined): boolean {
  const root = run === null || run === undefined ? undefined : runInitiator(run);
  return run?.nobodyWaiting === true && root !== undefined && root.type !== 'channel' && isUnattendedOrigin(root);
}

/**
 * `initiator` and `unattended` for an audit entry, from the run it belongs to. An entry without a run (or whose run has no origin)
 * is a system action: `{ type: 'system', wakeKind: 'system' }`, unattended.
 */
export function auditInitiatorFor(run: Pick<Run, 'origin' | 'rootOrigin'> | null | undefined): Pick<AuditEntry, 'initiator' | 'unattended'> {
  const initiator: RunOrigin = (run === null || run === undefined ? undefined : runInitiator(run)) ?? { type: 'system', wakeKind: 'system' };
  return { initiator, unattended: isUnattendedOrigin(initiator) };
}
