/**
 * Tells the agent what happened to a surface it acts on. computerd's control gateway decides who holds a screen or the owner's Mac
 * (BACKEND 7.8b); agentd only turns a change of holder into context for the model. A change reaches the agent as a system-origin wake
 * (kind hand_back, source screen_control), never as user text: a note is context, not an instruction. It steers a live run; an idle
 * session just keeps the note in its transcript and nothing starts a run on its own.
 *
 * The same change is announced from two triggers, the route that made it (fast, and does not depend on the event stream) and the
 * `control.changed` event (the only trigger for a Mac Stop, which no agentd route makes). Both build the same wake id,
 * `control:<surface>:<epoch>:<phase>:<conversationId>`, so the runner's enqueue dedupe makes a repeat a no-op.
 */
import { parseStoredRequest, surfaceKey, type HandBack, type Store, type StoredRequest, type SurfaceRef, type WakeEvent } from '@agent-desktop/contracts';
import type { AgentEvent, Run } from '@agent-desktop/public-contracts';
import { sessionKey } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import type { ComputerdClient } from '../computerd.js';
import { runWithOwner } from '../owner-scope.js';
import type { AgentdDeps } from './index.js';
import { recordDecision } from './requests.js';

const log = createLogger({ service: 'agentd' });
const LIVE = ['running', 'queued', 'waiting_for_input'];

export type ControlPhase = 'taken' | 'returned' | 'stopped' | 'resumed';

/** One committed change of holder, as much of it as the notice needs. */
export interface ControlChange {
  surface: SurfaceRef;
  /** The agent whose screen it is; absent for the Mac, which every agent with Mac access shares. */
  agentId?: string;
  epoch: number;
  phase: ControlPhase;
  /** On a release: what the person did and left behind. */
  handBack?: HandBack;
}

type NoticeDeps = Pick<AgentdDeps, 'store' | 'enqueuer'>;

interface Target {
  conversationId: string;
  /** The run in that conversation was held up by the change and has ended: continue it. */
  resume: boolean;
}

/** Live top-level runs of the agent, one query per status (an agent's history can be long). */
async function liveRuns(deps: NoticeDeps, agentId: string) {
  const out: Run[] = [];
  for (const status of LIVE) {
    const page = await deps.store.list('runs', { where: { agentId, status }, limit: 200 });
    out.push(...page.items.filter((run) => run.parentRunId === undefined && run.conversationId !== undefined));
  }
  return out;
}

/** The agent's newest top-level run (runs sort by start time), or undefined. */
async function latestRun(deps: NoticeDeps, agentId: string): Promise<Run | undefined> {
  const page = await deps.store.list('runs', { where: { agentId }, orderBy: 'at', order: 'desc', limit: 20 });
  return page.items.find((run) => run.parentRunId === undefined && run.conversationId !== undefined);
}

function wake(ownerId: string, agentId: string, conversationId: string, id: string, payload: Record<string, unknown>): WakeEvent {
  return {
    id,
    ownerId,
    agentId,
    sessionKey: sessionKey(agentId, conversationId),
    conversationId,
    kind: 'hand_back',
    origin: { type: 'system', label: 'screen control' },
    trusted: false,
    priority: 'background',
    payload: { source: 'screen_control', ...payload },
    at: new Date().toISOString(),
    status: 'accepted',
  };
}

async function send(deps: NoticeDeps, event: WakeEvent): Promise<void> {
  const result = await deps.enqueuer.enqueue(event).catch((error: unknown) => ({ accepted: false, reason: String(error) }));
  if (!result.accepted) log.warn({ agentId: event.agentId, reason: result.reason }, 'control note not delivered');
}

/** The agents a Mac change concerns: every agent of the owner that may use the Mac. */
async function macAgents(deps: NoticeDeps): Promise<string[]> {
  const page = await deps.store.list('agents', { limit: 200 });
  return page.items.filter((agent) => agent.macAccess).map((agent) => agent.id);
}

/** The person took the surface or stopped it: steer every live run of the agent. An agent with no live run needs no note. */
async function announceStart(deps: NoticeDeps, ownerId: string, agentId: string, change: ControlChange): Promise<void> {
  const conversations = [...new Set((await liveRuns(deps, agentId)).map((run) => run.conversationId ?? ''))].filter(Boolean);
  for (const conversationId of conversations) {
    await send(deps, wake(ownerId, agentId, conversationId, `control:${surfaceKey(change.surface)}:${change.epoch}:${change.phase}:${conversationId}`, { surface: change.surface.kind, phase: 'start' }));
  }
}

/**
 * Control is back: tell the conversation(s) the agent was working in. Live runs are steered. With none live, the agent's latest
 * conversation gets the note for its next message; if its run ended while the change held it up, that run is continued.
 */
async function announceEnd(deps: NoticeDeps, ownerId: string, agentId: string, change: ControlChange, handBack: HandBack): Promise<void> {
  const targets = new Map<string, Target>();
  for (const run of await liveRuns(deps, agentId)) {
    targets.set(run.conversationId ?? '', { conversationId: run.conversationId ?? '', resume: false });
  }
  const latest = targets.size === 0 ? await latestRun(deps, agentId) : undefined;
  if (latest?.conversationId) {
    const endedDuring = latest.finishedAt !== undefined && Date.parse(latest.finishedAt) >= Date.now() - handBack.heldMs;
    targets.set(latest.conversationId, { conversationId: latest.conversationId, resume: handBack.blocked && endedDuring && latest.status === 'completed' });
  }
  for (const target of targets.values()) {
    const payload = {
      surface: change.surface.kind, phase: 'end', heldMs: handBack.heldMs, changes: handBack.changes,
      ...(handBack.cancelled ? { cancelled: handBack.cancelled } : {}), ...(target.resume ? { resume: true } : {}),
    };
    await send(deps, wake(ownerId, agentId, target.conversationId, `control:${surfaceKey(change.surface)}:${change.epoch}:${change.phase}:${target.conversationId}`, payload));
  }
}

/** Announce one change of holder to the agent(s) it concerns. Safe to call twice for the same change. */
export async function announceControl(deps: NoticeDeps, ownerId: string, change: ControlChange): Promise<void> {
  const agents = change.agentId ? [change.agentId] : await macAgents(deps);
  const start = change.phase === 'taken' || change.phase === 'stopped';
  const handBack = change.handBack ?? { heldMs: 0, changes: [], blocked: false };
  for (const agentId of agents) {
    if (start) await announceStart(deps, ownerId, agentId, change);
    else await announceEnd(deps, ownerId, agentId, change, handBack);
  }
}

/** The agent's take-over requests still waiting on the user (a run suspended on each). */
export async function pendingComputerRequests(store: Store, agentId: string): Promise<StoredRequest[]> {
  const page = await store.list('requests', { where: { agentId, kind: 'computer', status: 'pending' }, limit: 20 });
  return page.items.map(parseStoredRequest);
}

/**
 * Control is back: every pending take-over request of the agent is answered "done", resuming its run. `recordDecision` writes the
 * answer with a conditional `status = 'pending'` update inside its transaction, so a second release, another process or a worker that
 * already closed the request cannot answer it twice (no in-process lock).
 */
export async function approveComputerRequests(deps: AgentdDeps, ownerId: string, agentId: string): Promise<void> {
  for (const pending of await pendingComputerRequests(deps.store, agentId)) {
    const recorded = await recordDecision(deps, ownerId, pending, { action: 'approve', note: 'The user handed control of the screen back.' });
    if ('error' in recorded && recorded.error.error.code !== 'REQUEST_NOT_PENDING') {
      log.warn({ requestId: pending.id, reason: recorded.error.error.message }, 'take-over answer not delivered');
    }
  }
}

/**
 * The event half of the notices: every committed `control.changed` is announced from here too (a Mac Stop or resume has no agentd
 * route). The hand-back text comes from the control row, which computerd keeps for the newest release. Returns the unsubscribe.
 */
export async function startControlNotices(args: {
  deps: NoticeDeps;
  bus: { subscribe(onEvent: (stored: { event: AgentEvent }) => void): Promise<() => void> };
  computerd: Pick<ComputerdClient, 'controlState'>;
}): Promise<() => void> {
  const handle = async (event: Extract<AgentEvent, { type: 'control.changed' }>): Promise<void> => {
    await runWithOwner(event.ownerId, async () => {
      const surface: SurfaceRef = event.surface;
      const released = event.phase === 'returned' || event.phase === 'resumed';
      const state = released ? await args.computerd.controlState(surface, new AbortController().signal) : null;
      const handBack = state && state.epoch === event.epoch ? state.handBack : undefined;
      await announceControl(args.deps, event.ownerId, {
        surface, epoch: event.epoch, phase: event.phase,
        ...(event.agentId ? { agentId: event.agentId } : {}), ...(handBack ? { handBack } : {}),
      });
    });
  };
  return args.bus.subscribe(({ event }) => {
    if (event.type === 'control.changed') handle(event).catch((error: unknown) => log.warn({ err: error }, 'control notice failed'));
  });
}
