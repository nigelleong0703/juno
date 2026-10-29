import {
  type ApiClient,
  type Computer,
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

// The pane only ever hands a real websocket to noVNC; jsdom cannot open one, so stub the client
// module with an inert RFB so the surface mounts without a network stack.
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

// jsdom lacks ResizeObserver, which the ui surfaces read on mount.
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

function screenFor(agentId: string, overrides: Partial<Computer["screens"] extends (infer S)[] | undefined ? S : never> = {}): NonNullable<Computer["screens"]>[number] {
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

const ticket: ScreenStreamTicket = {
  url: "wss://127.0.0.1:8787/v1/screens/screen-agent-juno/vnc?t=t-juno",
  expiresAt: "2026-10-05T09:35:00.000Z",
};

interface ClientOverrides {
  computer?: Computer;
  streamScreen?: (screenId: string, options?: { control?: boolean }) => Promise<ScreenStreamTicket>;
  takeOverScreen?: (screenId: string) => Promise<ScreenResponse>;
}

/** A live client: the demo mock with `mode: 'live'` and the computer surface stubbed to order. */
function createLiveClient(overrides: ClientOverrides = {}): ApiClient {
  const base = createMockClient({ seed: 3 });
  const comp = overrides.computer ?? computer();
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: [comp], nextCursor: null }),
    get: async () => comp,
    // Truthful backend: the screens endpoint lists the allocated displays, so the pane
    // member switcher sees the same screens as the embedded computer record.
    screens: async () => ({
      items: (comp.screens ?? []).map((s) => screenResponse(s.agentId)),
      nextCursor: null,
    }),
    screen: async (_computerId, agentId) => {
      const found = comp.screens?.find((s) => s.agentId === agentId);
      return found ? screenResponse(found.agentId) : null;
    },
    allocateScreen: async (_computerId, agentId) => screenResponse(agentId),
    streamScreen: overrides.streamScreen ?? (async () => ticket),
    screenshot: async () => ({ data: "x", mimeType: "image/png" }),
    takeOverScreen: overrides.takeOverScreen ?? (async () => screenResponse("agent-juno")),
    returnControlScreen: async () => screenResponse("agent-juno"),
  };
  return { ...base, mode: "live", computers };
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

/**
 * A live client for a brand-new agent whose machine does not exist yet. `list` starts empty and
 * only reflects a computer once `ensure` has produced one, so the test exercises the same
 * cache-seeding the real backend drives.
 */
function createNoComputerClient(
  ensure: ApiClient["computers"]["ensure"],
  overrides: Partial<ApiClient["computers"]> = {},
): ApiClient {
  const base = createMockClient({ seed: 3 });
  let stored: Computer | undefined;
  const toScreen = (computerId: string, screen: NonNullable<Computer["screens"]>[number]): ScreenResponse => ({
    ...screen,
    ownerId: "user-robin",
    computerId,
    controlEpoch: 0,
    resolution: "1364x1024",
    lastUsedAt: ISO,
  });
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: stored ? [stored] : [], nextCursor: null }),
    ensure: async (input) => {
      stored = await ensure(input);
      return stored;
    },
    screens: async () => {
      const current = stored;
      if (!current) return { items: [], nextCursor: null };
      return { items: (current.screens ?? []).map((s) => toScreen(current.id, s)), nextCursor: null };
    },
    screen: async (_computerId, agentId) => {
      const current = stored;
      const screen = current?.screens?.find((s) => s.agentId === agentId);
      return current && screen ? toScreen(current.id, screen) : null;
    },
    ...overrides,
  };
  return { ...base, mode: "live", computers };
}

describe("ComputerPane for an agent that can use the Mac", () => {
  const withMac = (base: ApiClient, runtime?: Awaited<ReturnType<ApiClient["computers"]["runtime"]>>): ApiClient => ({
    ...base,
    agents: { ...base.agents, get: async (id) => ({ ...(await base.agents.get(id)), macAccess: true }) },
    computers: {
      ...base.computers,
      myMac: async () => ({ paired: true, online: true, name: "Mac" }) as Awaited<ReturnType<ApiClient["computers"]["myMac"]>>,
      ...(runtime ? { runtime: async () => runtime } : {}),
    },
  });

  it("keeps the sandbox set-up and adds a Your Mac row", async () => {
    renderPane(withMac(createNoComputerClient(async () => computer())));

    await waitFor(() => expect(screen.getByText(tc("computer.mac.title"))).toBeTruthy());
    await waitFor(() => expect(screen.getByText(tc("computer.mac.online"))).toBeTruthy());
    expect(screen.getByText(tc("computer.mac.folder", { folder: "~/Juno" }))).toBeTruthy();
    expect(screen.getByText(tc("computer.ensure"))).toBeTruthy();
  });

  it("shows the install hint instead of Set up computer when there is no sandbox runtime", async () => {
    renderPane(withMac(createNoComputerClient(async () => computer()), { kind: "none", image: { state: "missing" }, installHint: "Install Apple container to give agents a sandbox." }));

    await waitFor(() => expect(screen.getByText("Install Apple container to give agents a sandbox.")).toBeTruthy());
    expect(screen.getByText(tc("computer.sandbox.install")).getAttribute("href")).toBe("https://github.com/apple/container/releases");
    expect(screen.queryByText(tc("computer.ensure"))).toBeNull();
    expect(screen.getByText(tc("computer.mac.title"))).toBeTruthy();
  });

  it("shows the image download progress", async () => {
    renderPane(createNoComputerClient(async () => computer(), { runtime: async () => ({ kind: "apple-container", image: { state: "pulling", progress: 0.4 } }) }));

    expect(await screen.findByText("40%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.queryByText(tc("computer.ensure"))).toBeNull();
    expect(screen.queryByText(tc("computer.mac.title"))).toBeNull();
  });
});

describe("ComputerPane without a computer", () => {
  it("keeps settings and close, and disables the action while allocation is pending", async () => {
    const ensure: ApiClient["computers"]["ensure"] = () => new Promise<Computer>(() => {});
    renderPane(createNoComputerClient(ensure));

    await waitFor(() => expect(screen.getByText(tc("computer.noComputerHint"))).toBeTruthy());
    // Header access survives the missing machine: settings (agent customization) and close.
    expect(screen.getByLabelText(tc("computer.action.settings"))).toBeTruthy();
    expect(screen.getByLabelText(tc("computer.action.close"))).toBeTruthy();
    // Routines live in the tab beside Chat files now; the setup pane carries no footer.
    expect(screen.queryByText(tc("computer.tab.routines"))).toBeNull();

    fireEvent.click(screen.getByText(tc("computer.ensure")));
    // Pending is honest: the label flips and the button is disabled, never a fabricated machine.
    await screen.findByText(tc("computer.ensure.pending"));
    expect(screen.getByText(tc("computer.ensure.pending")).closest("button")?.disabled).toBe(true);
  });

  it("shows the allocation error inline and retries it, then reveals the requested agent", async () => {
    const calls: Array<{ agentId?: string } | undefined> = [];
    const ensure: ApiClient["computers"]["ensure"] = async (input) => {
      calls.push(input);
      if (calls.length === 1) throw new Error("allocation failed");
      return computer({ agentIds: ["agent-juno"], screens: [screenFor("agent-juno")] });
    };
    const streamScreen = vi.fn(async () => ticket);
    renderPane(createNoComputerClient(ensure, { streamScreen }));

    await waitFor(() => expect(screen.getByText(tc("computer.ensure"))).toBeTruthy());
    fireEvent.click(screen.getByText(tc("computer.ensure")));
    // The server message is actionable, not swallowed, and the retry stays available.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("allocation failed"));
    fireEvent.click(screen.getByText(tc("computer.screen.retry")));

    // Retry re-issues the explicit allocation for the selected agent and the machine appears.
    await waitFor(() => expect(calls).toEqual([{ agentId: "agent-juno" }, { agentId: "agent-juno" }]));
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    expect(screen.queryByText(tc("computer.noComputerHint"))).toBeNull();
  });

  it("keeps the settings menu reachable while the machine is missing", async () => {
    const ensure: ApiClient["computers"]["ensure"] = () => new Promise<Computer>(() => {});
    renderPane(createNoComputerClient(ensure));

    const settings = await screen.findByLabelText(tc("computer.action.settings"));
    // Radix menus open on pointerdown, which a real click dispatches first.
    fireEvent.pointerDown(settings, { button: 0, ctrlKey: false });
    expect(await screen.findByText(tc("computer.action.agentSettings"))).toBeTruthy();
  });

  it("finishes by allocating a screen when the machine row already exists", async () => {
    let row: Computer | undefined;
    const allocateScreen = vi.fn(async (_computerId: string, agentId: string) => screenResponse(agentId));
    const ensure: ApiClient["computers"]["ensure"] = async () => {
      // The machine row was created before the display allocation failed.
      row = computer({ agentIds: ["agent-juno"], screens: [] });
      throw new Error("screen allocation failed");
    };
    const client = createNoComputerClient(ensure, {
      list: async () => ({ items: row ? [row] : [], nextCursor: null }),
      allocateScreen,
    });
    renderPane(client);

    await waitFor(() => expect(screen.getByText(tc("computer.ensure"))).toBeTruthy());
    fireEvent.click(screen.getByText(tc("computer.ensure")));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("screen allocation failed"));

    // Retry re-checks the machine: it exists, so the action must allocate the display, not re-ensure.
    fireEvent.click(screen.getByText(tc("computer.screen.retry")));
    await waitFor(() => expect(allocateScreen).toHaveBeenCalledWith("computer-shared", "agent-juno"));
  });
});

describe("ComputerPane live screens", () => {
  it("requests the real stream ticket for a ready screen (no mock desktop)", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      streamScreen,
    });
    renderPane(client);

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    // A live client must not fabricate a desktop while the real one is available.
    expect(screen.queryByText(tc("computer.screen.none.title"))).toBeNull();
  });

  it("shows a truthful loading state until the ticket arrives", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      streamScreen: () => new Promise<ScreenStreamTicket>(() => {}),
    });
    renderPane(client);

    await waitFor(() =>
      expect(screen.getByText(tc("computer.screen.starting", { name: "Juno" }))).toBeTruthy(),
    );
  });

  it("shows an honest error when the ticket fails", async () => {
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      streamScreen: async () => {
        throw new Error("ticket failed");
      },
    });
    renderPane(client);

    await waitFor(() => expect(screen.getByText(tc("computer.screen.error.title"))).toBeTruthy());
  });

  it("defaults to the agent in view even when another agent drives the shared VM", async () => {
    const streamScreen = vi.fn(async (_id: string) => ticket);
    const client = createLiveClient({
      // The shared VM's `activeAgentId` points at Patch; the 1:1 chat is Juno's OWN display.
      computer: computer({
        activeAgentId: "agent-patch",
        screens: [screenFor("agent-juno"), screenFor("agent-patch")],
      }),
      streamScreen,
    });
    renderPane(client, "agent-juno");

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    expect(streamScreen).not.toHaveBeenCalledWith("screen-agent-patch", expect.anything());
  });

  it("takes over the screen the user is viewing", async () => {
    const takeOverScreen = vi.fn(async (id: string) => screenResponse(id));
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      takeOverScreen,
    });
    renderPane(client);

    await waitFor(() => expect(screen.getByText(tc("computer.takeOver"))).toBeTruthy());
    fireEvent.click(screen.getByText(tc("computer.takeOver")));
    await waitFor(() => expect(takeOverScreen).toHaveBeenCalledWith("screen-agent-juno"));
  });

  it("requests a writable ticket after taking over the viewed screen", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno")] }),
      streamScreen,
      // The screen the pane first fetched still reports agent control; the takeover returns user.
      takeOverScreen: async () => screenResponse("agent-juno", { controller: "user" }),
    });
    renderPane(client);

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    fireEvent.click(await screen.findByText(tc("computer.takeOver")));

    // The stale agent-control screen must not win: the writable ticket follows the takeover.
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: true }));
  });

  it("switches to another member's screen on an explicit group-chat pick", async () => {
    const streamScreen = vi.fn(async (_id: string) => ticket);
    const client = createLiveClient({
      computer: computer({
        screens: [screenFor("agent-juno"), screenFor("agent-patch")],
      }),
      streamScreen,
    });
    renderPane(client, "agent-juno", "conv-launch");

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));

    // Radix menus open on pointerdown, which is what a real click dispatches first.
    fireEvent.pointerDown(screen.getByLabelText(tc("computer.screen.pick")), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText(tc("computer.screen.pickMember", { name: "Patch" })));

    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-patch", { control: false }));
  });
});
