/**
 * Projection of computerd's view onto the app's \`Computer\` contract, and the id translation between
 * the two worlds.
 *
 * computerd speaks in sandbox ids; the app speaks in one \`Computer\` row id. Exposing both would give
 * the UI two ids for one machine, so every public screen is remapped to the computer row id and the
 * sandbox id stays internal (Backend as a Service, BACKEND §9).
 */
import type { Computer, ComputerScreen } from '@agent-desktop/public-contracts';
import type { ScreenResponse, Store } from '@agent-desktop/contracts';
import type { ComputerdClient, ComputerView, PublicScreen } from '../computerd.js';
import { ComputerdClientError } from '../computerd.js';

/** The one public computer row for this owner, created on first ensure. */
export async function projectComputer(
  store: Store,
  ownerId: string,
  view: ComputerView,
  /** The agent the caller is ensuring for; its binding is persisted on the computer row. */
  agentId: string | undefined,
  /** The configured screen size (COMPUTER_RESOLUTION) every screen boots with. */
  resolution: string,
): Promise<Computer> {
  const patch = {
    state: 'running' as const,
    resolution,
    os: view.template,
    lastUpdatedAt: new Date().toISOString(),
    resources: resources(view),
    size: {
      vcpu: view.metrics?.vcpu ?? 2,
      ramGb: Math.max(1, Math.round((view.metrics?.memTotalMb ?? 2048) / 1024)),
      diskGb: Math.max(1, Math.round((view.metrics?.diskTotalGb ?? 20) / 1024)),
    },
  };
  const existing = (await store.list('computers', { limit: 1 })).items[0];
  if (existing) {
    // Ids of deleted agents are dropped here too, so an old binding never lingers on the row.
    const live = await liveAgentIds(store, existing.agentIds);
    const agentIds = agentId && !live.includes(agentId) ? [...live, agentId] : live;
    return store.patch('computers', existing.id, { ...patch, agentIds });
  }
  const computer: Computer = {
    id: `computer-${ownerId}`,
    agentIds: agentId ? [agentId] : [],
    activeAgentId: null,
    name: 'Computer',
    state: 'running',
    controller: 'agent',
    resources: patch.resources,
    size: patch.size,
    idlePauseMinutes: 30,
    updateSchedule: { kind: 'auto' },
    uptimeSeconds: 0,
    os: view.template,
    resolution,
    lastUpdatedAt: new Date().toISOString(),
  };
  return store.put('computers', computer);
}

async function liveAgentIds(store: Store, ids: string[]): Promise<string[]> {
  const rows = await Promise.all(ids.map((id) => store.get('agents', id)));
  return ids.filter((_, i) => rows[i] !== null);
}

/**
 * Remove a deleted agent from the owner's computer: its id on the computer row and its screen rows.
 * computerd frees the agent's display itself the next time another agent needs one.
 */
export async function detachAgentFromComputer(store: Store, agentId: string): Promise<void> {
  const computer = (await store.list('computers', { limit: 1 })).items[0];
  if (computer) {
    const screens = computer.screens?.filter((screen) => screen.agentId !== agentId);
    await store.patch('computers', computer.id, {
      agentIds: computer.agentIds.filter((id) => id !== agentId),
      ...(computer.activeAgentId === agentId ? { activeAgentId: null } : {}),
      ...(screens ? { screens } : {}),
    });
  }
  for (;;) {
    const page = await store.list('screens', { where: { agentId }, limit: 50 });
    const own = page.items.filter((screen) => screen.agentId === agentId);
    for (const screen of own) {
      await store.delete('screens', screen.id);
      await store.delete('controls', `screen:${screen.id}`);
    }
    if (own.length === 0 || !page.nextCursor) break;
  }
}

/** Fold a freshly allocated screen into the computer projection the app receives back. */
export function withScreen(computer: Computer, screen: PublicScreen): Computer {
  const entry: ComputerScreen = {
    id: screen.id,
    agentId: screen.agentId,
    displayNo: screen.displayNo,
    state: screen.state,
    controller: screen.controller,
    title: screen.title,
  };
  const screens = computer.screens ?? [];
  const next = screens.some((s) => s.id === entry.id)
    ? screens.map((s) => (s.id === entry.id ? entry : s))
    : [...screens, entry];
  return { ...computer, screens: next };
}

/** The public computer row id, without creating one (falls back to the deterministic id). */
export async function computerIdFor(store: Store, ownerId: string): Promise<string> {
  const existing = (await store.list('computers', { limit: 1 })).items[0];
  return existing?.id ?? `computer-${ownerId}`;
}

/**
 * Rewrite a screen so the app only ever sees the public computer id. The owner id is kept:
 * the renderer's screen contract requires it, and it is validated against the authenticated
 * owner here so a screen can never leak across owners. Never fabricate ownership instead.
 */
export function remapScreen(screen: ScreenResponse, computerId: string, ownerId: string): PublicScreen {
  if (screen.ownerId !== ownerId) {
    throw new ComputerdClientError(403, 'forbidden', 'screen belongs to a different owner');
  }
  const { computerId: _sandbox, ...rest } = screen;
  return { ...rest, computerId, ownerId: screen.ownerId };
}

function resources(view: ComputerView): Computer['resources'] {
  const metrics = view.metrics;
  return {
    cpu: { used: metrics?.cpuPercent ?? 0, total: 100, unit: 'percent', cores: metrics?.vcpu ?? 2 },
    memory: { used: metrics?.memUsedMb ?? 0, total: metrics?.memTotalMb ?? 2048, unit: 'MB' },
    disk: { used: metrics?.diskUsedGb ?? 0, total: metrics?.diskTotalGb ?? 20, unit: 'GB' },
  };
}

/**
 * The one way the owner's computer comes up, whether the owner pressed "Set up computer" or an agent started using it:
 * connect to the owner's sandbox (created when there is none), record its row, and, for an agent, allocate that agent's
 * display. Every path goes through here, so the row and the sandbox cannot drift apart.
 */
export async function ensureComputer(
  store: Store,
  computerd: Pick<ComputerdClient, 'computer' | 'ensureScreen'>,
  ownerId: string,
  agentId: string | undefined,
  resolution: string,
  signal: AbortSignal,
): Promise<Computer> {
  const computer = await projectComputer(store, ownerId, await computerd.computer(signal), agentId, resolution);
  if (agentId === undefined) return computer;
  const screen = remapScreen(await computerd.ensureScreen(agentId, signal), computer.id, ownerId);
  return withScreen(computer, screen);
}
