import type { AgentEvent, Computer, ComputerScreen, MacStatus, ScreenResponse } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/**
 * Live-screen data (SB3). Every network shape comes from SB1's frozen contract
 * (`backend/sandbox-adapters/CONTRACT.md`): one display per agent, a short-lived signed stream ticket and a
 * server-side VNC password. The renderer never sees or stores a single password.
 */

/** The screen this agent owns on the shared computer, or `null` before it is allocated. */
export function resolveAgentScreen(
  computer: { screens?: ComputerScreen[] } | undefined,
  agentId: string | undefined,
): ComputerScreen | null {
  if (!computer || !agentId) return null;
  return computer.screens?.find((screen) => screen.agentId === agentId) ?? null;
}

/** Record a screen the API just returned into the cached computer, so the pane updates at once. */
function mergeScreen(
  qc: ReturnType<typeof useQueryClient>,
  computerId: string,
  screen: ScreenResponse,
): void {
  const projection: ComputerScreen = {
    id: screen.id,
    agentId: screen.agentId,
    displayNo: screen.displayNo,
    state: screen.state,
    controller: screen.controller,
    title: screen.title,
  };
  const patch = <T extends { id: string; screens?: ComputerScreen[] }>(old: T | undefined) => {
    if (!old) return old;
    const screens = old.screens ?? [];
    const next = screens.some((s) => s.id === projection.id)
      ? screens.map((s) => (s.id === projection.id ? projection : s))
      : [...screens, projection];
    return { ...old, screens: next };
  };
  qc.setQueryData(qk.computer(computerId), patch);
  qc.setQueriesData<{ id: string; screens?: ComputerScreen[] }[]>(
    { queryKey: qk.computers() },
    (old) => old?.map((c) => (c.id === computerId ? patch(c) ?? c : c)),
  );
  // The pane reads the per-agent screen query and the computer's screen list directly, and
  // `fetchedScreen` wins over the embedded copy: a controller change must land in both, or a
  // taken-over screen would keep reporting stale ownership and never get a writable ticket.
  qc.setQueryData<ScreenResponse | null>(qk.screen(computerId, screen.agentId), (old) =>
    old === undefined ? old : screen,
  );
  qc.setQueriesData<ScreenResponse[]>({ queryKey: qk.screens(computerId) }, (old) =>
    mergeScreenList(old, screen),
  );
}

/** Replace the matching screen in the cached list, or append it; never duplicates an id. */
function mergeScreenList(old: ScreenResponse[] | undefined, screen: ScreenResponse): ScreenResponse[] | undefined {
  if (!old) return old;
  return old.some((s) => s.id === screen.id)
    ? old.map((s) => (s.id === screen.id ? screen : s))
    : [...old, screen];
}

/**
 * This agent's screen for the computer in view. `enabled` guards the brand-new-agent case where no
 * computer exists yet; a 404 (`no_screen`) resolves to `null` and drives the honest empty state.
 */
export function useAgentScreen(computerId: string | undefined, agentId: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.screen(computerId ?? "", agentId ?? ""),
    queryFn: () => client.computers.screen(computerId as string, agentId as string),
    enabled: Boolean(computerId && agentId),
  });
}

/** Every display allocated inside the computer (used by the group member selector). */
export function useComputerScreens(computerId: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.screens(computerId ?? ""),
    queryFn: async () => (await client.computers.screens(computerId as string)).items,
    enabled: Boolean(computerId),
  });
}

/** A short-lived, server-signed stream ticket for one screen. Never carries a VNC password. */
export function useScreenStreamTicket(screenId: string | undefined, control: boolean) {
  const client = useClient();
  return useQuery({
    queryKey: qk.screenStream(screenId ?? "", control),
    queryFn: () => client.computers.streamScreen(screenId as string, { control }),
    enabled: Boolean(screenId),
    // The ticket is verified ONCE, on the websocket handshake. `staleTime` keeps the same signed URL
    // while the pane is mounted, and there is deliberately NO refetch interval: an automatic refetch
    // would rotate the ticket and force the stream to reconnect every few minutes, waking an
    // otherwise idle VM through the proxy. A passive view can idle; an explicit retry (RF1) fetches
    // a fresh ticket when a new connection is actually needed.
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Allocate this agent's own display on the shared computer (idempotent on the server). */
export function useEnsureScreen() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ computerId, agentId }: { computerId: string; agentId: string }) =>
      client.computers.allocateScreen(computerId, agentId),
    onSuccess: (screen, { computerId }) => {
      mergeScreen(qc, computerId, screen);
      void qc.invalidateQueries({ queryKey: qk.computers() });
    },
  });
}

/**
 * The screen a person acts on. A fetched screen carries `controlEpoch`, which goes to the server as the epoch this tap saw: if control
 * changed hands since (the agent or another device moved it), the server leaves it alone and answers with the current row.
 */
export type ScreenControlTarget = Pick<ComputerScreen, "id"> & Partial<Pick<ScreenResponse, "controlEpoch">>;

/** Take over / return control of a single screen without touching the others. The epoch goes along when the screen was fetched (the embedded list copy has none). */
export function useScreenControl() {
  const client = useClient();
  const qc = useQueryClient();

  const takeOver = useMutation({
    mutationFn: (target: ScreenControlTarget) =>
      target.controlEpoch === undefined
        ? client.computers.takeOverScreen(target.id)
        : client.computers.takeOverScreen(target.id, { expectEpoch: target.controlEpoch }),
    onSuccess: (screen) => mergeScreen(qc, screen.computerId, screen),
  });
  const returnControl = useMutation({
    mutationFn: (target: ScreenControlTarget) =>
      target.controlEpoch === undefined
        ? client.computers.returnControlScreen(target.id)
        : client.computers.returnControlScreen(target.id, { expectEpoch: target.controlEpoch }),
    onSuccess: (screen) => mergeScreen(qc, screen.computerId, screen),
  });

  return { takeOver, returnControl };
}

type ControlChanged = Extract<AgentEvent, { type: "control.changed" }>;

/**
 * `control.changed`: who may act on a surface changed (the person took a screen or handed it back, the Mac was Stopped or resumed). The
 * event carries the new holder and epoch; every cached copy of that screen, or the Mac's status, takes them at once. An event older than
 * what the cache already holds (a replay) changes nothing.
 */
export function applyControlChange(qc: QueryClient, event: ControlChanged): void {
  if (event.surface.kind === "mac") {
    qc.setQueryData<MacStatus>(qk.myMac(), (old) => {
      if (!old) return old;
      if (event.holder !== "stopped") {
        if (old.stopped && event.epoch < old.stopped.epoch) return old;
        const { stopped: _stopped, ...running } = old;
        return running;
      }
      return old.stopped && event.epoch < old.stopped.epoch ? old : { ...old, stopped: { since: event.since, epoch: event.epoch } };
    });
    return;
  }
  const { screenId } = event.surface;
  const controller = event.holder === "user" ? "user" : "agent";
  const patchScreen = <T extends ComputerScreen & Partial<ScreenResponse>>(screen: T): T =>
    screen.id !== screenId || (screen.controlEpoch !== undefined && event.epoch < screen.controlEpoch)
      ? screen
      : { ...screen, controller, controlEpoch: event.epoch, controllerSince: event.since };
  qc.setQueriesData<ScreenResponse | null>({ queryKey: ["screen"] }, (old) => (old ? patchScreen(old) : old));
  qc.setQueriesData<ScreenResponse[]>({ queryKey: ["screens"] }, (old) => old?.map(patchScreen));
  const embedded = <T extends { screens?: ComputerScreen[] }>(computer: T): T =>
    computer.screens?.some((screen) => screen.id === screenId)
      ? { ...computer, screens: computer.screens.map((screen) => (screen.id === screenId ? { ...screen, controller } : screen)) }
      : computer;
  qc.setQueriesData<Computer>({ queryKey: ["computer"] }, (old) => (old ? embedded(old) : old));
  qc.setQueriesData<Computer[]>({ queryKey: ["computers"] }, (old) => old?.map(embedded));
}

/**
 * Create the shared VM binding if it is missing (idempotent); used before first screen use. The
 * server returns the projected computer (with the requested agent bound), so seed the caches from
 * that exact row: the selected agent then sees its machine immediately, without waiting for a
 * refetch that a schema-rejecting list would swallow.
 */
export function useEnsureComputer() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId?: string) => client.computers.ensure(agentId ? { agentId } : {}),
    onSuccess: (computer, agentId) => {
      qc.setQueryData(qk.computer(computer.id), computer);
      qc.setQueryData<Computer[]>(qk.computers(), (old) => mergeComputer(old, computer));
      void qc.invalidateQueries({ queryKey: qk.computers() });
      void qc.invalidateQueries({ queryKey: qk.screens(computer.id) });
      if (agentId) void qc.invalidateQueries({ queryKey: qk.screen(computer.id, agentId) });
    },
  });
}

/** Replace the matching computer in the cached list, or append the new one. */
function mergeComputer(old: Computer[] | undefined, computer: Computer): Computer[] {
  if (!old) return [computer];
  return old.some((c) => c.id === computer.id)
    ? old.map((c) => (c.id === computer.id ? computer : c))
    : [...old, computer];
}

/**
 * Which agent's screen the pane is showing. In a group chat the user can switch between the
 * members' own displays; in a 1:1 chat it is always the agent in view.
 */
export function useSelectedScreenAgent(
  computer: { screens?: ComputerScreen[] } | undefined,
  agentId: string,
  override?: string,
): string {
  // `computer` stays in the signature for callers, but the explicit pick never reads
  // `computer.screens`: the public computer projection omits embedded screens (they are
  // fetched separately via useComputerScreens), so gating the override on that list would
  // discard a valid group-member choice. Membership is already enforced by the caller selector.
  void computer;
  return useMemo(() => {
    // Default to the agent in view (its OWN display). `activeAgentId` must never decide the
    // default aim: in a 1:1 chat the pane shows that agent even while another agent drives
    // its own display. Only an explicit group-chat pick (override) switches away.
    if (override) return override;
    return agentId;
  }, [override, agentId]);
}
