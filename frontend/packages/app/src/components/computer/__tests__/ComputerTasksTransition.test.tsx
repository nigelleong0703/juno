import {
  type ApiClient,
  type Computer,
  type PlanItem,
  type Routine,
  type ScreenResponse,
  type ScreenStreamTicket,
} from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ComputerPaneSlot } from "../../../shell/ComputerPaneSlot";
import { ComputerPane } from "../ComputerPane";
import { tc } from "../i18n";
import { LiveScreen } from "../LiveScreen";

// jsdom cannot open a websocket, so drive the noVNC lifecycle with an RFB that only
// emits `connect` when the test says so. Firing is keyed by stream URL so each ticket
// (read vs write, juno vs patch) connects independently.
const connectBus = vi.hoisted(() => {
  const handlers = new Map<string, Array<() => void>>();
  return {
    fire(url: string): void {
      for (const fn of handlers.get(url) ?? []) fn();
    },
    reset(): void {
      handlers.clear();
    },
    handlers,
  };
});

vi.mock("@novnc/novnc", () => {
  class FakeRfb {
    viewOnly = true;
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    background = "";
    constructor(
      public target: HTMLElement,
      public url: string,
    ) {
      // A painted frame: the canvas carries its ticket URL, like a real framebuffer.
      const canvas = document.createElement("canvas");
      canvas.width = 1364;
      canvas.height = 1024;
      canvas.setAttribute("data-frame", url);
      target.appendChild(canvas);
    }
    // Never removes the canvas: retention and pruning belong to the hook under test.
    disconnect(): void {}
    addEventListener(type: string, listener: (event: Event) => void): void {
      if (type !== "connect") return;
      const list = connectBus.handlers.get(this.url) ?? [];
      list.push(() => listener({} as Event));
      connectBus.handlers.set(this.url, list);
    }
    removeEventListener(): void {}
  }
  return { default: FakeRfb };
});

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  connectBus.reset();
});

/** Painted-frame markers (`data-frame`) across a rendered tree. */
function paintedFrames(base: HTMLElement): string[] {
  return Array.from(base.querySelectorAll("canvas"))
    .map((canvas) => canvas.getAttribute("data-frame") ?? "")
    .filter((frame) => frame.length > 0);
}

const ISO = "2026-10-05T09:30:00.000Z";

function computer(overrides: Partial<Computer> = {}): Computer {
  return {
    id: "computer-shared",
    agentIds: ["agent-juno", "agent-patch"],
    activeAgentId: null,
    screens: [],
    name: "Your computer",
    state: "running",
    controller: "agent",
    resources: {
      cpu: { used: 5, total: 100, unit: "%", cores: 8 },
      memory: { used: 512, total: 16384, unit: "MB" },
      disk: { used: 4, total: 128, unit: "GB" },
    },
    size: { vcpu: 8, ramGb: 16, diskGb: 128 },
    idlePauseMinutes: 30,
    updateSchedule: { kind: "manual" },
    uptimeSeconds: 60,
    os: "Debian 13 · Xfce",
    resolution: "1364x1024",
    lastUpdatedAt: ISO,
    ...overrides,
  };
}

type ScreenT = NonNullable<Computer["screens"]>[number];

function screenFor(agentId: string, overrides: Partial<ScreenT> = {}): ScreenT {
  return {
    id: `screen-${agentId}`,
    agentId,
    displayNo: agentId === "agent-juno" ? 1 : 2,
    state: "live",
    controller: "agent",
    title: agentId,
    ...overrides,
  };
}

function screenResponse(agentId: string, overrides: Partial<ScreenResponse> = {}): ScreenResponse {
  return {
    ...screenFor(agentId),
    ownerId: "user-robin",
    computerId: "computer-shared",
    controlEpoch: 0,
    resolution: "1364x1024",
    lastUsedAt: ISO,
    ...overrides,
  };
}

function ticketFor(screenId: string, control: boolean): ScreenStreamTicket {
  return {
    url: `wss://127.0.0.1:8787/v1/screens/${screenId}/vnc?t=${control ? "w" : "r"}`,
    expiresAt: "2026-10-05T09:35:00.000Z",
  };
}

function routine(
  id: string,
  agentId: string,
  name: string,
  delivery: Routine["delivery"],
): Routine {
  return {
    id,
    agentId,
    name,
    instructions: "Do the thing on schedule.",
    trigger: { kind: "schedule", cron: "0 9 * * 1", human: "Weekly on Monday 9:00", tz: "Asia/Singapore" },
    delivery,
    notify: { mode: "always" },
    enabled: true,
    status: "active",
    runs: [],
    createdAt: ISO,
  };
}

interface ClientOverrides {
  computer?: Computer;
  streamScreen?: (screenId: string, options?: { control?: boolean }) => Promise<ScreenStreamTicket>;
  takeOverScreen?: (screenId: string) => Promise<ScreenResponse>;
  returnControlScreen?: (screenId: string) => Promise<ScreenResponse>;
  routines?: Routine[];
  /** Authoritative task plans served by `agents.tasks` (defaults to none). */
  agentTasks?: () => Promise<PlanItem[]>;
}

function createLiveClient(overrides: ClientOverrides = {}): ApiClient {
  const base = createMockClient({ seed: 3 });
  const comp = overrides.computer ?? computer();
  const toScreen = (s: ScreenT): ScreenResponse => ({
    ...s,
    ownerId: "user-robin",
    computerId: comp.id,
    controlEpoch: 0,
    resolution: "1364x1024",
    lastUsedAt: ISO,
  });
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: [comp], nextCursor: null }),
    get: async () => comp,
    screens: async () => ({
      items: (comp.screens ?? []).map(toScreen),
      nextCursor: null,
    }),
    screen: async (_computerId, agentId) => {
      const found = comp.screens?.find((s) => s.agentId === agentId);
      return found ? toScreen(found) : null;
    },
    allocateScreen: async (_computerId, agentId) => toScreen(screenFor(agentId)),
    streamScreen: overrides.streamScreen ?? (async (id, options) => ticketFor(id, options?.control ?? false)),
    screenshot: async () => ({ data: "x", mimeType: "image/png" }),
    takeOverScreen:
      overrides.takeOverScreen ??
      (async (id) => screenResponse(id.replace("screen-", ""), { controller: "user" })),
    returnControlScreen:
      overrides.returnControlScreen ?? (async () => screenResponse("agent-juno", { controller: "agent" })),
  };
  const routines: ApiClient["routines"] = {
    ...base.routines,
    list: async (params) =>
      overrides.routines
        ? { items: overrides.routines, nextCursor: null }
        : base.routines.list(params),
  };
  const agents: ApiClient["agents"] = {
    ...base.agents,
    plans: async () => ({ items: overrides.agentTasks ? await overrides.agentTasks() : [], nextCursor: null }),
  };
  return { ...base, mode: "live", computers, routines, agents };
}

function renderPane(client: ApiClient, agentId = "agent-juno", conversationId?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} platform={webPlatform} queryClient={queryClient}>
          <ComputerPane agentId={agentId} conversationId={conversationId} />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

function renderSlot(client: ApiClient, agentId = "agent-juno", conversationId = "conv-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} platform={webPlatform} queryClient={queryClient}>
          <ComputerPaneSlot agentId={agentId} conversationId={conversationId} />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("Routines tab conversation scoping", () => {
  const scopedRoutines = [
    routine("r-here", "agent-juno", "Chat scoped here", { channel: "chat", target: "conv-1" }),
    routine("r-other", "agent-juno", "Other chat routine", { channel: "chat", target: "conv-9" }),
    routine("r-legacy", "agent-juno", "Legacy unscoped", { channel: "chat" }),
    routine("r-slack", "agent-juno", "Slack routine", { channel: "slack", target: "#eng" }),
    routine("r-patch", "agent-patch", "Patch chat routine", { channel: "chat", target: "conv-1" }),
  ];

  it("lists only this chat routines and explains legacy unscoped ones", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      routines: scopedRoutines,
    });
    renderSlot(client, "agent-juno", "conv-1");

    fireEvent.click(screen.getByRole("tab", { name: "Routines" }));

    await waitFor(() => expect(screen.getByText("Chat scoped here")).toBeTruthy());
    expect(screen.getByText("Slack routine")).toBeTruthy();
    // Another chat target never leaks in, legacy unscoped is explained, not listed.
    expect(screen.queryByText("Other chat routine")).toBeNull();
    expect(screen.queryByText("Legacy unscoped")).toBeNull();
    expect(screen.queryByText("Patch chat routine")).toBeNull();
    expect(screen.getByText(tc("computer.routines.unscopedHint", { name: "the agent" }))).toBeTruthy();
  });
});

describe("Ongoing tasks under the screen", () => {
  it("lists unfinished todos from the plan endpoint, not run history", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      agentTasks: async () => [
        {
          id: "plan-live",
          conversationId: "conv-juno",
          at: "2026-10-05T09:30:00.000Z",
          type: "plan",
          runId: "run-live",
          agentId: "agent-juno",
          todos: [{ id: "t-open", text: "Triage the inbox and draft replies", status: "in_progress" }],
        },
      ],
    });
    renderPane(client);

    await waitFor(() => expect(screen.getByText("Triage the inbox and draft replies")).toBeTruthy());
    expect(screen.getByText(tc("computer.tasks.title"))).toBeTruthy();
    // Run history is not a task source: the completed run title never surfaces here.
    expect(screen.queryByText("Compare Firecracker and gVisor sandboxes")).toBeNull();
  });
});

describe("Control handover transition", () => {
  it("holds the same-agent frame under a translucent overlay while the write ticket lands", async () => {
    let releaseWrite!: (ticket: ScreenStreamTicket) => void;
    const writeGate = new Promise<ScreenStreamTicket>((resolve) => {
      releaseWrite = resolve;
    });
    const streamScreen = vi.fn(async (id: string, options?: { control?: boolean }) =>
      options?.control ? writeGate : ticketFor(id, false),
    );
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      streamScreen,
      takeOverScreen: async () => screenResponse("agent-juno", { controller: "user" }),
    });
    renderPane(client);

    const readUrl = ticketFor("screen-agent-juno", false).url;
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    // The read session must be mounted (painted canvas) before its connect fires.
    await waitFor(() => expect(paintedFrames(document.body)).toEqual([readUrl]));
    connectBus.fire(readUrl);

    fireEvent.click(await screen.findByText(tc("computer.takeOver")));
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: true }));

    // The ticket gap keeps the held frame mounted under a translucent overlay:
    // no empty flash, and the overlay (not the stale ticket) takes interaction.
    await waitFor(() => expect(screen.getByTestId("screen-transition")).toBeTruthy());
    expect(screen.getAllByTestId("novnc-container")).toHaveLength(1);
    expect(paintedFrames(document.body)).toEqual([readUrl]);

    releaseWrite(ticketFor("screen-agent-juno", true));
    const writeUrl = ticketFor("screen-agent-juno", true).url;
    // Ticket rotation retires (never destroys) the old session: both painted frames
    // are mounted under a translucent reconnect veil until the fresh one connects.
    await waitFor(() => expect(paintedFrames(document.body)).toHaveLength(2));
    expect(paintedFrames(document.body)).toContain(readUrl);
    const veil = await screen.findByTestId("screen-reconnect");
    expect(veil.className).toContain("bg-black/35");

    connectBus.fire(writeUrl);
    // The fresh connection drops the retired layer: exactly its frame remains.
    await waitFor(() => expect(paintedFrames(document.body)).toEqual([writeUrl]));
    await waitFor(() => expect(screen.queryByTestId("screen-transition")).toBeNull());
    expect(screen.queryByTestId("screen-reconnect")).toBeNull();
    await waitFor(() => expect(screen.getByText(tc("computer.control.returnToAgent"))).toBeTruthy());
  });

  it("never leaks the previous screen when the selected agent changes", async () => {
    let releasePatch!: (ticket: ScreenStreamTicket) => void;
    const patchGate = new Promise<ScreenStreamTicket>((resolve) => {
      releasePatch = resolve;
    });
    const streamScreen = vi.fn(async (id: string, options?: { control?: boolean }) => {
      if (id === "screen-agent-patch") return patchGate;
      return ticketFor(id, options?.control ?? false);
    });
    const client = createLiveClient({
      computer: computer({
        screens: [screenFor("agent-juno"), screenFor("agent-patch")],
      }),
      streamScreen,
    });
    renderPane(client, "agent-juno", "conv-launch");

    const junoUrl = ticketFor("screen-agent-juno", false).url;
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    await waitFor(() => expect(paintedFrames(document.body)).toEqual([junoUrl]));
    connectBus.fire(junoUrl);

    fireEvent.pointerDown(screen.getByLabelText(tc("computer.screen.pick")), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText(tc("computer.screen.pickMember", { name: "Patch" })));

    // While the newly selected display loads, the old pixels are gone — an honest
    // placeholder, never a handover overlay over the wrong screen.
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-patch", { control: false }));
    expect(screen.queryByTestId("screen-transition")).toBeNull();
    expect(screen.queryAllByTestId("novnc-container")).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByText(tc("computer.screen.starting", { name: "Patch" }))).toBeTruthy(),
    );

    releasePatch(ticketFor("screen-agent-patch", false));
    await waitFor(() => expect(screen.queryAllByTestId("novnc-container")).toHaveLength(1));
  });

  it("takes over the explicitly selected member screen, not the conversation agent", async () => {
    const takeOverScreen = vi.fn(async () => screenResponse("agent-patch", { controller: "user" }));
    const streamScreen = vi.fn(async (id: string, options?: { control?: boolean }) =>
      ticketFor(id, options?.control ?? false),
    );
    const client = createLiveClient({
      computer: computer({
        screens: [screenFor("agent-juno"), screenFor("agent-patch")],
      }),
      streamScreen,
      takeOverScreen,
    });
    renderPane(client, "agent-juno", "conv-launch");

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    await waitFor(() =>
      expect(paintedFrames(document.body)).toEqual([ticketFor("screen-agent-juno", false).url]),
    );
    connectBus.fire(ticketFor("screen-agent-juno", false).url);

    fireEvent.pointerDown(screen.getByLabelText(tc("computer.screen.pick")), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText(tc("computer.screen.pickMember", { name: "Patch" })));
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-patch", { control: false }));
    await waitFor(() =>
      expect(paintedFrames(document.body)).toEqual([ticketFor("screen-agent-patch", false).url]),
    );
    connectBus.fire(ticketFor("screen-agent-patch", false).url);

    fireEvent.click(await screen.findByText(tc("computer.takeOver")));
    // The tap carries the epoch of the screen it saw, so a stale tap cannot flip a screen that changed hands meanwhile.
    await waitFor(() => expect(takeOverScreen).toHaveBeenCalledWith("screen-agent-patch", { expectEpoch: 0 }));
    // The guard follows the viewed screen: Patch shows control truth and a write ticket.
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-patch", { control: true }));
    await waitFor(() => expect(screen.getByText(tc("computer.control.returnToAgent"))).toBeTruthy());
  });
});

describe("Selected-screen frame privacy", () => {
  const targetA = { url: "wss://host/display-a" };
  const targetB = { url: "wss://host/display-b" };

  function renderSurface(screenKey: string | null, target: { url: string } | null) {
    return render(
      <ThemeProvider defaultTheme="dark">
        <LiveScreen computer={computer()} target={target} screenKey={screenKey} />
      </ThemeProvider>,
    );
  }

  it("clears the painted frame the moment another display is selected", async () => {
    const rendered = renderSurface("screen-a", targetA);
    await waitFor(() => expect(paintedFrames(rendered.container)).toEqual([targetA.url]));
    connectBus.fire(targetA.url);

    rendered.rerender(
      <ThemeProvider defaultTheme="dark">
        <LiveScreen computer={computer()} target={targetB} screenKey="screen-b" />
      </ThemeProvider>,
    );
    // The previous pixels are gone before the new display even connects.
    expect(paintedFrames(rendered.container)).toHaveLength(0);

    await waitFor(() => expect(paintedFrames(rendered.container)).toEqual([targetB.url]));
    expect(paintedFrames(rendered.container)).not.toContain(targetA.url);
  });

  it("keeps the painted frame across a same-screen ticket rotation", async () => {
    const rotated = { url: "wss://host/display-a?rotated" };
    const rendered = renderSurface("screen-a", targetA);
    await waitFor(() => expect(paintedFrames(rendered.container)).toEqual([targetA.url]));
    connectBus.fire(targetA.url);

    rendered.rerender(
      <ThemeProvider defaultTheme="dark">
        <LiveScreen computer={computer()} target={rotated} screenKey="screen-a" />
      </ThemeProvider>,
    );
    // Retired, not destroyed: both painted frames mounted under a soft veil.
    await waitFor(() => expect(paintedFrames(rendered.container)).toHaveLength(2));
    expect(paintedFrames(rendered.container)).toContain(targetA.url);
    expect(await screen.findByTestId("screen-reconnect")).toBeTruthy();

    connectBus.fire(rotated.url);
    await waitFor(() => expect(paintedFrames(rendered.container)).toEqual([rotated.url]));
    expect(screen.queryByTestId("screen-reconnect")).toBeNull();
  });
});
