/**
 * The control gateway (BACKEND 7.8b): the one source of "who may act on this surface right now" for every surface a person can
 * take or stop (an agent's cloud screen; the owner's Mac, whose Chrome is its browser capability). Nothing else stores or decides
 * it. The state is a row in `controls` (id `screen:<id>` / `mac:<id>`); every change of holder is one store transaction that takes
 * the row's lock, compares, bumps `epoch`, writes the audit entry and emits `control.changed`, so two processes (or two taps) can
 * never both "win" and the agent is told once.
 *
 * Agent actions pass `admit()`. `take()` writes the new holder first (every later admit is refused), then waits up to `drainMs` for
 * this process's in-flight agent actions and aborts what is still running; a result that arrives after the change carries a note.
 * After a release the first mutating screen action must be preceded by a fresh look (`resumeSnapshotRequired`).
 */
import type { AuditEntry } from '@agent-desktop/public-contracts';
import {
  surfaceKey,
  type ControlActor, type ControlState, type HandBack, type Store, type SurfaceRef, type SurfaceSnapshot,
} from '@agent-desktop/contracts';
import { ComputerdError, notAllowed } from '@agent-desktop/sandbox-adapters';

export const DRAIN_MS = 3_000;
const SNAPSHOT_MS = 3_000;
/** What the agent reads when an action finished after control had already moved. */
export const CONTROL_CHANGED_NOTE = 'Control changed during this action; inspect the current state before continuing.';

/** The refusal an agent action gets while a person holds (or has stopped) the surface, or has not been looked at since a hand-back. */
export class ControlRefusal extends ComputerdError {
  constructor(message: string, readonly surface: SurfaceRef['kind'], readonly holder: ControlState['holder'], readonly reason?: 'inspect_first') {
    super('user_control', message, { surface, holder, ...(reason ? { reason } : {}) });
  }
}

/** What differs per kind of surface; the gateway itself knows nothing about browsers or Macs. */
export interface SurfaceEffects {
  /** The browser as it is now (a screen). Bounded by the gateway; a failure or timeout reads as "could not be read". */
  snapshot?(surface: SurfaceRef, signal: AbortSignal): Promise<SurfaceSnapshot>;
  /** Short lines describing what changed between two snapshots. */
  diff?(before: SurfaceSnapshot | undefined, after: SurfaceSnapshot): string[];
  /** After the person took it / after it went back (start and stop the browser watchdog). Never awaited. */
  taken?(surface: SurfaceRef): void;
  released?(surface: SurfaceRef): void;
}

export interface ControlGatewayOptions {
  /** Owner-scoped store. */
  store: Store;
  ownerId: string;
  effects?: SurfaceEffects;
  drainMs?: number;
}

export interface Admission {
  epoch: number;
  /** Aborts when control moves and the action outlives the drain window. */
  signal: AbortSignal;
  /** Call when the action ends. True when control changed while it ran (the result gets CONTROL_CHANGED_NOTE). */
  done(): boolean;
}

export interface AdmitOptions {
  /** Changes what is on screen (click, type, navigate, a browser write): refused after a hand-back until the agent has looked. */
  mutation: boolean;
  /** A screenshot or snapshot: satisfies the "look first" requirement. */
  looks?: boolean;
}

export interface ControlGateway {
  get(surface: SurfaceRef, agentId?: string): Promise<ControlState>;
  /** Hear every change committed by THIS process, at once (a writable stream closes without waiting for its next poll). Returns the unsubscribe. */
  subscribe(listener: (state: ControlState) => void): () => void;
  /** Create the row if the surface has none yet (a screen allocated, a Mac paired). Never changes an existing row. */
  ensure(surface: SurfaceRef, agentId?: string): Promise<ControlState>;
  take(surface: SurfaceRef, actor: ControlActor, options?: { agentId?: string; expectEpoch?: number; reason?: string; requestId?: string; signal?: AbortSignal }): Promise<{ state: ControlState; changed: boolean }>;
  release(surface: SurfaceRef, actor: ControlActor, options?: { agentId?: string; expectEpoch?: number; signal?: AbortSignal }): Promise<{ state: ControlState; changed: boolean; handBack?: HandBack }>;
  stop(surface: SurfaceRef, actor: ControlActor, options?: { agentId?: string; cancelled?: string[] }): Promise<{ state: ControlState; changed: boolean }>;
  resume(surface: SurfaceRef, actor: ControlActor, options?: { agentId?: string }): Promise<{ state: ControlState; changed: boolean; handBack?: HandBack }>;
  /** `agentId` is absent for work that is not one agent's (a Mac's shell or files). */
  admit(surface: SurfaceRef, agentId: string | undefined, options: AdmitOptions): Promise<Admission>;
  /** Whether a stream may write now: a read-write ticket needs the person to hold the surface. */
  streamTicket(surface: SurfaceRef, wantControl: boolean): Promise<{ epoch: number; control: boolean }>;
}

const CAPABILITIES: Record<SurfaceRef['kind'], ControlState['capabilities']> = {
  screen: { take: true, stop: false, resumeRemote: true },
  mac: { take: false, stop: true, resumeRemote: false },
};

function baseline(surface: SurfaceRef, ownerId: string, agentId: string | undefined, now: string): ControlState {
  return {
    id: surfaceKey(surface), ownerId, surface, ...(agentId ? { agentId } : {}),
    holder: 'agent', epoch: 0, since: now, resumeSnapshotRequired: false, capabilities: CAPABILITIES[surface.kind],
  };
}

const PHASE = { take: 'taken', release: 'returned', stop: 'stopped', resume: 'resumed' } as const;
const WORDS = {
  screen: { take: 'Took control of the agent screen', release: 'Handed the agent screen back' },
  mac: { stop: 'Stopped all agent access to the Mac', resume: 'Resumed agent access to the Mac' },
} as const;

/** Bound a promise: its value, or `fallback` after `ms` (the work is abandoned). */
function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
    work.then((value) => resolve(value), () => resolve(fallback)).finally(() => clearTimeout(timer));
  });
}

/** The lock every change of one surface takes: a screen's own (always present) row, a Mac's control row (created when it is paired). */
async function lockRow(tx: Store, surface: SurfaceRef): Promise<void> {
  if (!tx.getForUpdate) throw new Error('control changes need a store with row locks');
  if (surface.kind === 'screen') await tx.getForUpdate('screens', surface.screenId);
  else await tx.getForUpdate('controls', surfaceKey(surface));
}

interface InFlight {
  controller: AbortController;
  settled: Promise<void>;
  finish(): void;
  epoch: number;
  changed: boolean;
}

export function createControlGateway(options: ControlGatewayOptions): ControlGateway {
  const { store, ownerId } = options;
  const effects = options.effects ?? {};
  const drainMs = options.drainMs ?? DRAIN_MS;
  const inFlight = new Map<string, Set<InFlight>>();
  const listeners = new Set<(state: ControlState) => void>();
  const nowIso = () => new Date().toISOString();

  const read = async (surface: SurfaceRef, agentId?: string): Promise<ControlState> =>
    (await store.get('controls', surfaceKey(surface))) ?? baseline(surface, ownerId, agentId, nowIso());

  /**
   * One transaction: lock, re-read, let `change` decide, write + audit + emit. A screen locks its (always present) screen row, so even the
   * first change of a never-changed screen is serialised; a Mac's row is created at pairing for the same reason.
   */
  async function flip(
    surface: SurfaceRef,
    actor: ControlActor,
    verb: keyof typeof PHASE,
    agentId: string | undefined,
    change: (current: ControlState) => ControlState | undefined,
  ): Promise<{ state: ControlState; changed: boolean }> {
    const key = surfaceKey(surface);
    const { state, changed } = await store.tx(async (tx) => {
      await lockRow(tx, surface);
      const current = (await tx.get('controls', key)) ?? baseline(surface, ownerId, agentId, nowIso());
      const next = change(current);
      if (!next) return { state: current, changed: false };
      const stored = await tx.put('controls', next, { ...(next.agentId ? { agentId: next.agentId } : {}), status: next.holder, kind: surface.kind });
      const words = WORDS[surface.kind] as Record<string, string>;
      const audit: AuditEntry = {
        id: `aud-control-${key.replace(':', '-')}-${next.epoch}`,
        at: next.since, actor: 'user',
        ...(next.agentId ? { agentId: next.agentId } : {}), ...(actor.userId ? { memberId: actor.userId } : {}),
        action: words[verb] ?? verb, target: key, decision: verb === 'take' || verb === 'stop' ? 'handed_off' : 'auto_allowed',
        reason: `The person did this themselves (${actor.via}); it needs no approval.`,
        // The person acted directly, with no run behind it: the contract has no origin for that, so it is filed as a user-control system action and is not unattended.
        initiator: { type: 'system', wakeKind: 'user_control', label: actor.via }, unattended: false,
      };
      await tx.put('audit', audit, { ...(next.agentId ? { agentId: next.agentId } : {}), kind: `control.${verb}` });
      await tx.emit({ type: 'control.changed', ownerId, surface: next.surface, ...(next.agentId ? { agentId: next.agentId } : {}), holder: next.holder, epoch: next.epoch, since: next.since, phase: PHASE[verb] });
      return { state: stored, changed: true };
    });
    if (changed) for (const listener of [...listeners]) listener(state);
    return { state, changed };
  }

  const moved = (current: ControlState, holder: ControlState['holder'], more: Partial<ControlState> = {}): ControlState => {
    const { before: _before, cancelled: _cancelled, handBack: _handBack, reason: _reason, requestId: _requestId, blockedAt: _blockedAt, ...kept } = current;
    return { ...kept, holder, epoch: current.epoch + 1, since: nowIso(), resumeSnapshotRequired: false, ...more };
  };

  const stale = (current: ControlState, expectEpoch: number | undefined) => expectEpoch !== undefined && current.epoch !== expectEpoch;

  /** Wait for this process's in-flight actions on the surface, at most `drainMs`; abort what is still running. */
  async function drain(key: string): Promise<void> {
    const running = [...(inFlight.get(key) ?? [])];
    for (const action of running) action.changed = true;
    if (running.length === 0) return;
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const expired = new Promise<'expired'>((resolve) => { timer.id = setTimeout(() => resolve('expired'), drainMs); timer.id.unref(); });
    const outcome = await Promise.race([Promise.all(running.map((action) => action.settled)).then(() => 'drained' as const), expired]);
    clearTimeout(timer.id);
    if (outcome === 'expired') for (const action of running) action.controller.abort(new Error(CONTROL_CHANGED_NOTE));
  }

  const snapshotOf = async (surface: SurfaceRef, signal?: AbortSignal): Promise<SurfaceSnapshot | undefined> =>
    effects.snapshot ? bounded(effects.snapshot(surface, signal ?? new AbortController().signal), SNAPSHOT_MS, {}) : undefined;

  const gateway: ControlGateway = {
    get: read,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async ensure(surface, agentId) {
      const existing = await store.get('controls', surfaceKey(surface));
      if (existing) return existing;
      const created = baseline(surface, ownerId, agentId, nowIso());
      // A concurrent first writer may have flipped it already: only write when still absent, inside the lock the flip uses.
      return store.tx(async (tx) => {
        await lockRow(tx, surface);
        return (await tx.get('controls', created.id)) ?? tx.put('controls', created, { ...(agentId ? { agentId } : {}), status: 'agent', kind: surface.kind });
      });
    },

    async take(surface, actor, opts = {}) {
      const key = surfaceKey(surface);
      if (!CAPABILITIES[surface.kind].take) throw notAllowed('this surface cannot be taken over');
      const read0 = await read(surface, opts.agentId);
      if (read0.holder === 'user') return { state: read0, changed: false };
      // The browser as it is before the flip (afterwards agent tools are refused); bounded so a stuck sandbox cannot hold the take-over hostage.
      const before = await snapshotOf(surface, opts.signal);
      const result = await flip(surface, actor, 'take', opts.agentId, (current) => {
        if (current.holder === 'user' || stale(current, opts.expectEpoch)) return undefined;
        return moved(current, 'user', {
          ...(before ? { before } : {}), ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.requestId ? { requestId: opts.requestId } : {}),
        });
      });
      if (result.changed) {
        effects.taken?.(surface);
        await drain(key);
      }
      return result;
    },

    async release(surface, actor, opts = {}) {
      const read0 = await read(surface, opts.agentId);
      if (read0.holder !== 'user') return { state: read0, changed: false };
      const after = effects.snapshot ? await snapshotOf(surface, opts.signal) : undefined;
      let handBack: HandBack | undefined;
      const result = await flip(surface, actor, 'release', opts.agentId, (current) => {
        if (current.holder !== 'user' || stale(current, opts.expectEpoch)) return undefined;
        handBack = {
          heldMs: Math.max(0, Date.now() - Date.parse(current.since)),
          changes: after && effects.diff ? effects.diff(current.before, after) : [],
          blocked: current.blockedAt !== undefined,
        };
        return moved(current, 'agent', { resumeSnapshotRequired: surface.kind === 'screen', handBack });
      });
      if (result.changed) effects.released?.(surface);
      return { ...result, ...(result.changed && handBack ? { handBack } : {}) };
    },

    async stop(surface, actor, opts = {}) {
      if (!CAPABILITIES[surface.kind].stop) throw notAllowed('this surface cannot be stopped');
      const result = await flip(surface, actor, 'stop', opts.agentId, (current) => {
        if (current.holder === 'stopped') return undefined;
        return moved(current, 'stopped', opts.cancelled && opts.cancelled.length > 0 ? { cancelled: opts.cancelled } : {});
      });
      if (result.changed) await drain(surfaceKey(surface));
      else if (opts.cancelled && opts.cancelled.length > 0 && result.state.holder === 'stopped' && result.state.cancelled === undefined) {
        // A Stop made on another client reached the Mac first; the Mac now reports what it cancelled. Same epoch, no new event.
        const cancelled = opts.cancelled;
        await store.tx(async (tx) => {
          await lockRow(tx, surface);
          const row = await tx.get('controls', surfaceKey(surface));
          if (row?.holder === 'stopped' && row.cancelled === undefined) await tx.put('controls', { ...row, cancelled }, { ...(row.agentId ? { agentId: row.agentId } : {}), status: row.holder, kind: surface.kind });
        }).catch(() => undefined);
      }
      return result;
    },

    async resume(surface, actor, opts = {}) {
      const caps = CAPABILITIES[surface.kind];
      if (!caps.resumeRemote && actor.via !== 'mac-local') throw notAllowed('this can be resumed only on the Mac itself');
      let handBack: HandBack | undefined;
      const result = await flip(surface, actor, 'resume', opts.agentId, (current) => {
        if (current.holder !== 'stopped') return undefined;
        handBack = {
          heldMs: Math.max(0, Date.now() - Date.parse(current.since)), changes: [], blocked: current.blockedAt !== undefined,
          ...(current.cancelled && current.cancelled.length > 0 ? { cancelled: current.cancelled } : {}),
        };
        return moved(current, 'agent', { resumeSnapshotRequired: true, handBack });
      });
      return { ...result, ...(result.changed && handBack ? { handBack } : {}) };
    },

    async admit(surface, agentId, opts) {
      const key = surfaceKey(surface);
      const current = await read(surface, agentId);
      if (current.holder !== 'agent') {
        if (current.blockedAt === undefined) await markBlocked(surface);
        throw new ControlRefusal(
          current.holder === 'user' ? `the user has taken over ${agentId ?? 'the agent'}'s ${surface.kind}` : `the user has stopped agent access to the ${surface.kind}`,
          surface.kind, current.holder,
        );
      }
      if (current.resumeSnapshotRequired) {
        if (opts.mutation && !opts.looks) {
          throw new ControlRefusal('control changed hands since your last look: take a fresh screenshot or snapshot first', surface.kind, 'agent', 'inspect_first');
        }
        if (opts.looks) await clearLook(surface, current.epoch);
      }
      const controller = new AbortController();
      let finish = () => undefined as void;
      const action: InFlight = { controller, epoch: current.epoch, changed: false, finish: () => finish(), settled: new Promise<void>((resolve) => { finish = resolve; }) };
      const set = inFlight.get(key) ?? new Set<InFlight>();
      set.add(action);
      inFlight.set(key, set);
      return {
        epoch: current.epoch,
        signal: controller.signal,
        done() {
          set.delete(action);
          if (set.size === 0) inFlight.delete(key);
          action.finish();
          return action.changed || controller.signal.aborted;
        },
      };
    },

    async streamTicket(surface, wantControl) {
      const current = await read(surface);
      return { epoch: current.epoch, control: wantControl && current.holder === 'user' };
    },
  };

  /** Remember an agent action was refused, so the hand-back can continue a run that stopped waiting. */
  async function markBlocked(surface: SurfaceRef): Promise<void> {
    await store.tx(async (tx) => {
      await lockRow(tx, surface);
      const row = await tx.get('controls', surfaceKey(surface));
      if (row && row.holder !== 'agent' && row.blockedAt === undefined) await tx.put('controls', { ...row, blockedAt: nowIso() }, { ...(row.agentId ? { agentId: row.agentId } : {}), status: row.holder, kind: surface.kind });
    }).catch(() => undefined);
  }

  /** The agent has looked: later mutating actions of this epoch are allowed. A change of holder in between wins (the epoch no longer matches). */
  async function clearLook(surface: SurfaceRef, epoch: number): Promise<void> {
    await store.tx(async (tx) => {
      await lockRow(tx, surface);
      const row = await tx.get('controls', surfaceKey(surface));
      if (row && row.epoch === epoch && row.resumeSnapshotRequired) await tx.put('controls', { ...row, resumeSnapshotRequired: false }, { ...(row.agentId ? { agentId: row.agentId } : {}), status: row.holder, kind: surface.kind });
    }).catch(() => undefined);
  }

  return gateway;
}
