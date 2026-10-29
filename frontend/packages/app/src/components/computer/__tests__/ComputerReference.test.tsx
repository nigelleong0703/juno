import {
  type ApiClient,
  type Computer,
  type EnsureComputerInput,
  type PlanItem,
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
import { ComputerPane } from "../ComputerPane";
import { tc } from "../i18n";

// Same jsdom shims as the pane suite: noVNC cannot open a websocket here, and the ui
// surfaces read ResizeObserver on mount.
vi.mock("@novnc/novnc", () => {
  class FakeRfb {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    background = "";
    constructor(public target: HTMLElement, public url: string) {}
    disconnect(): void {}
    addEventListener(): void {}
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

afterEach(cleanup);

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

function screenResponse(agentId: string): ScreenResponse {
  return {
    ...screenFor(agentId),
    ownerId: "user-robin",
    computerId: "computer-shared",
    controlEpoch: 0,
    resolution: "1364x1024",
    lastUsedAt: ISO,
  };
}

const ticket: ScreenStreamTicket = {
  url: "wss://127.0.0.1:8787/v1/screens/screen-agent-juno/vnc?t=t-juno",
  expiresAt: "2026-10-05T09:35:00.000Z",
};

interface ClientOverrides {
  computer?: Computer;
  streamScreen?: (screenId: string, options?: { control?: boolean }) => Promise<ScreenStreamTicket>;
  takeOverScreen?: (screenId: string) => Promise<ScreenResponse>;
  returnControlScreen?: (screenId: string) => Promise<ScreenResponse>;
  screen?: (computerId: string, agentId: string) => Promise<ScreenResponse | null>;
  ensureComputer?: (input?: EnsureComputerInput) => Promise<Computer>;
  /** Authoritative task plans served by `agents.tasks` (defaults to none). */
  agentTasks?: () => Promise<PlanItem[]>;
}

function createLiveClient(overrides: ClientOverrides = {}): ApiClient {
  const base = createMockClient({ seed: 3 });
  const comp = overrides.computer ?? computer();
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: [comp], nextCursor: null }),
    get: async () => comp,
    screens: async () => ({ items: [], nextCursor: null }),
    screen: overrides.screen
      ?? (async (_computerId, agentId) => {
        const found = comp.screens?.find((s) => s.agentId === agentId);
        return found ? screenResponse(found.agentId) : null;
      }),
    allocateScreen: async (_computerId, agentId) => screenResponse(agentId),
    streamScreen: overrides.streamScreen ?? (async () => ticket),
    screenshot: async () => ({ data: "x", mimeType: "image/png" }),
    takeOverScreen: overrides.takeOverScreen ?? (async () => screenResponse("agent-juno")),
    ensure: overrides.ensureComputer ?? base.computers.ensure,
    returnControlScreen: overrides.returnControlScreen ?? (async () => screenResponse("agent-juno")),
  };
  const agents: ApiClient["agents"] = {
    ...base.agents,
    plans: async () => ({ items: overrides.agentTasks ? await overrides.agentTasks() : [], nextCursor: null }),
  };
  return { ...base, mode: "live", computers, agents };
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

/** Open the settings menu the way a real pointer does (Radix opens on pointerdown). */
async function openSettings(): Promise<void> {
  fireEvent.pointerDown(screen.getByLabelText(tc("computer.action.settings")), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText(tc("computer.action.agentSettings"));
}

describe("ComputerPane reference composition", () => {
  it("renders the screen preview, a single control pill and tasks with no default tab strip", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
    });
    const { container } = renderPane(client);

    await waitFor(() =>
      expect(container.querySelector('[data-layout="computer-reference-layout"]')).toBeTruthy(),
    );
    // One control pill under the frame names the live executor; the old "{name}'s screen"
    // caption that repeated the selector is gone.
    expect(screen.getByText(tc("computer.control.agentHasControl", { name: "Juno" }))).toBeTruthy();
    expect(screen.queryByText(tc("computer.preview.title", { name: "Juno" }))).toBeNull();
    // Routines moved to the tab beside Chat files; the pane keeps the actual
    // ongoing tasks under the screen instead.
    expect(screen.getByText(tc("computer.tasks.title"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: tc("computer.tab.routines") })).toBeNull();
    // The old default tab strip is gone; secondary views open from the settings menu.
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("keeps an honest aspect frame when there is no screen yet", async () => {
    const client = createLiveClient({ computer: computer({ screens: [] }) });
    const { container } = renderPane(client);

    // The truthful placeholder renders instead of a fabricated desktop…
    await waitFor(() => expect(screen.getByText(tc("computer.screen.none.title"))).toBeTruthy());
    expect(screen.getByText(tc("computer.screen.start"))).toBeTruthy();
    // …inside the fixed-ratio frame, which keeps stage width so it cannot collapse.
    const frame = container.querySelector('[style*="aspect-ratio"]');
    expect(frame).toBeTruthy();
    expect(frame?.className).toContain("w-full");
    expect(container.querySelector('[data-layout="computer-reference-layout"]')).toBeTruthy();
  });

  it("lists the actual ongoing tasks under the screen from the plan endpoint", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      agentTasks: async () => [
        {
          id: "plan-live",
          conversationId: "conv-juno",
          at: ISO,
          type: "plan",
          runId: "run-live",
          agentId: "agent-juno",
          todos: [
            { id: "t-open", text: "Triage the inbox and draft replies", status: "in_progress" },
            { id: "t-done", text: "Archive the newsletter threads", status: "done" },
          ],
        },
      ],
    });
    renderPane(client);

    // The unfinished todo is ongoing; a done entry in the same plan never surfaces.
    await waitFor(() => expect(screen.getByText("Triage the inbox and draft replies")).toBeTruthy());
    expect(screen.getByText(tc("computer.tasks.title"))).toBeTruthy();
    expect(screen.queryByText("Archive the newsletter threads")).toBeNull();
    expect(screen.queryByText(tc("computer.tasks.empty"))).toBeNull();
  });

  it("stays quiet under the screen when no task is outstanding", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      agentTasks: async () => [],
    });
    renderPane(client);

    await waitFor(() => expect(screen.getByText(tc("computer.tasks.empty"))).toBeTruthy());
  });

  it("disables Take over until the viewed screen is actually live", async () => {
    const takeOverScreen = vi.fn(async (id: string) => screenResponse(id));
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno", { state: "starting" })] }),
      takeOverScreen,
    });
    renderPane(client);

    const button = await screen.findByText(tc("computer.takeOver"));
    expect(button.closest("button")?.disabled).toBe(true);
    fireEvent.click(button);
    expect(takeOverScreen).not.toHaveBeenCalled();
  });

  it("shows live control truth under the screen and takes over from there", async () => {
    const takeOverScreen = vi.fn(async (id: string) => screenResponse(id));
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      takeOverScreen,
    });
    renderPane(client);

    await waitFor(() =>
      expect(screen.getByText(tc("computer.control.agentHasControl", { name: "Juno" }))).toBeTruthy(),
    );
    fireEvent.click(screen.getByText(tc("computer.takeOver")));
    await waitFor(() => expect(takeOverScreen).toHaveBeenCalledWith("screen-agent-juno"));
  });

  it("offers Return to agent once the user holds the screen", async () => {
    const returnControlScreen = vi.fn(async (id: string) => screenResponse(id));
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno", { controller: "user" })] }),
      returnControlScreen,
    });
    renderPane(client);

    await waitFor(() => expect(screen.getByText(tc("computer.control.youHaveControl"))).toBeTruthy());
    fireEvent.click(screen.getByText(tc("computer.control.returnToAgent")));
    await waitFor(() => expect(returnControlScreen).toHaveBeenCalledWith("screen-agent-juno"));
  });

  it("routes Agent settings to the existing page and keeps the menu lean", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
    });
    renderPane(client);
    await waitFor(() =>
      expect(screen.getByLabelText(tc("computer.action.settings"))).toBeTruthy(),
    );

    await openSettings();
    expect(screen.getByText(tc("computer.action.agentSettings"))).toBeTruthy();
    expect(screen.queryByText(tc("computer.action.advanced"))).toBeNull();
    expect(screen.queryByText(tc("computer.action.teach"))).toBeNull();
    expect(screen.queryByText(tc("computer.action.close"))).toBeNull();
    expect(screen.queryByText("All routines")).toBeNull();
    fireEvent.click(screen.getByText(tc("computer.action.agentSettings")));
    expect(window.location.hash).toContain("/agents/agent-juno/settings");
  });

  it("offers Members for a group chat without removing the screen switcher", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno"), screenFor("agent-patch")] }),
    });
    renderPane(client, "agent-juno", "conv-launch");
    await waitFor(() => expect(screen.getByLabelText(tc("computer.screen.pick"))).toBeTruthy());

    await openSettings();
    const items = await screen.findAllByText(tc("computer.tab.members"));
    const menuEntry = items.find((el) => el.closest('[role="menuitem"]') !== null) ?? items.at(-1);
    if (!menuEntry) throw new Error("members menu entry missing");
    fireEvent.click(menuEntry);
    // The drill-down opens under its own title, outside any menu.
    await waitFor(() => expect(screen.getByText(tc("computer.action.back"))).toBeTruthy());
    const titles = screen.getAllByText(tc("computer.tab.members"));
    expect(titles.some((el) => el.closest('[role="menuitem"]') === null)).toBe(true);
  });  it("streams the fetched screen even when the computers list carries none", async () => {
    // SC1: the list response has no screens, but the per-agent query does. The pane must
    // use the fetched record, not conclude there is no display.
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [] }),
      screen: async () => screenResponse("agent-juno"),
      streamScreen,
    });
    renderPane(client);

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    expect(screen.queryByText(tc("computer.screen.none.title"))).toBeNull();
  });

  it("disables Start while allocating and reports the server error as-is", async () => {
    const gate: { reject: ((error: Error) => void) | null } = { reject: null };
    const client = createLiveClient({
      computer: computer({ screens: [] }),
      ensureComputer: () =>
        new Promise<Computer>((_resolve, reject) => {
          gate.reject = reject;
        }),
    });
    renderPane(client);

    const start = await screen.findByText(tc("computer.screen.start"));
    fireEvent.click(start.closest("button") ?? start);
    await waitFor(() => expect(start.closest("button")?.disabled).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();

    gate.reject?.(new Error("vm quota exhausted"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("vm quota exhausted");
  });

  it("keeps the routines footer out of the screen pane", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
    });
    renderPane(client);

    // Routines now live in the tab beside Chat files; the screen pane carries only
    // ongoing tasks. Other agents' schedules must never leak under this screen.
    await waitFor(() => expect(screen.getByText(tc("computer.tasks.title"))).toBeTruthy());
    expect(screen.queryByText("Daily inbox triage")).toBeNull();
    expect(screen.queryByText("CI watch")).toBeNull();
    expect(screen.queryByText("Invoice chase")).toBeNull();
    expect(screen.queryByText(tc("computer.tab.routines"))).toBeNull();
  });

  it("keeps pending sign-in requests out of the pane without gating the screen", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      streamScreen,
    });
    renderPane(client);

    // No global sign-in section in the pane: the external request lives in chat cards.
    await waitFor(() =>
      expect(screen.getByText(tc("computer.control.agentHasControl", { name: "Juno" }))).toBeTruthy(),
    );
    expect(screen.queryByText(tc("computer.mode.signin.done"))).toBeNull();
    expect(screen.queryByText(tc("computer.mode.signin.title"))).toBeNull();
    // Viewing is never gated by the seeded request: the ticket is still requested.
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
  });

  it("surfaces a screen query failure as an error, not an empty display", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [] }),
      screen: async () => {
        throw new Error("screen schema rejected");
      },
    });
    const { container } = renderPane(client);

    await waitFor(() => expect(screen.getByText(tc("computer.screen.error.title"))).toBeTruthy());
    expect(screen.queryByText(tc("computer.screen.none.title"))).toBeNull();
    expect(screen.getByText(tc("computer.screen.retry"))).toBeTruthy();
    expect(container.querySelector('[data-layout="computer-reference-layout"]')).toBeTruthy();
  });
});
