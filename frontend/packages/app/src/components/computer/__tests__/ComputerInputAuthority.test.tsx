import type {
  ApiClient,
  Computer,
  ScreenResponse,
  ScreenStreamTicket,
} from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ComputerPane } from "../ComputerPane";
import { ComputerView } from "../ComputerView";
import { tc } from "../i18n";

const rfbInstances = vi.hoisted(() => [] as Array<EventTarget & { url: string; viewOnly: boolean }>);

vi.mock("@novnc/novnc", () => {
  class FakeRfb extends EventTarget {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    background = "";
    constructor(public target: HTMLElement, public url: string) {
      super();
      rfbInstances.push(this);
    }
    disconnect(): void {}
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
  rfbInstances.length = 0;
});

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
    os: "Debian 13",
    resolution: "1364x1024",
    lastUpdatedAt: ISO,
    ...overrides,
  };
}

type EmbeddedScreen = Computer["screens"] extends (infer S)[] | undefined ? S : never;

function screenFor(agentId: string, overrides: Partial<EmbeddedScreen> = {}): EmbeddedScreen {
  return {
    id: "screen-" + agentId,
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

/** The fetched record keeps the embedded lease: the pane prefers it over the list copy. */
function fetchedScreen(found: EmbeddedScreen): ScreenResponse {
  return {
    ...found,
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
}

function createLiveClient(overrides: ClientOverrides = {}): ApiClient {
  const base = createMockClient({ seed: 3 });
  const comp = overrides.computer ?? computer();
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: [comp], nextCursor: null }),
    get: async () => comp,
    screens: async () => ({
      items: (comp.screens ?? []).map((s) => fetchedScreen(s)),
      nextCursor: null,
    }),
    screen: async (_computerId, agentId) => {
      const found = comp.screens?.find((s) => s.agentId === agentId);
      return found ? fetchedScreen(found) : null;
    },
    allocateScreen: async (_computerId, agentId) => screenResponse(agentId),
    streamScreen: overrides.streamScreen ?? (async () => ticket),
    screenshot: async () => ({ data: "x", mimeType: "image/png" }),
    takeOverScreen: async () => screenResponse("agent-juno"),
    returnControlScreen: async () => screenResponse("agent-juno"),
  };
  return { ...base, mode: "live", computers };
}

function renderPane(client: ApiClient, agentId = "agent-juno") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} platform={webPlatform} queryClient={queryClient}>
          <ComputerPane agentId={agentId} />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

async function lastViewOnly(): Promise<boolean> {
  await waitFor(() => expect(rfbInstances.length).toBeGreaterThan(0));
  const last = rfbInstances.at(-1);
  if (!last) throw new Error("noVNC surface never mounted");
  return last.viewOnly;
}

/** Fail the live RFB session so the surface shows its Reconnect overlay. */
function failLatestSurface(): void {
  const rfb = rfbInstances.at(-1);
  if (!rfb) throw new Error("noVNC surface never mounted");
  rfb.dispatchEvent(new CustomEvent("securityfailure", { detail: { reason: "ticket expired" } }));
}

function reconnectButton(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: /reconnect/i });
}

describe("screen input authority", () => {
  it("keeps the user live control interactive under a pending needs-you banner", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno", { controller: "user" })] }),
      streamScreen,
    });
    renderPane(client);
    await waitFor(() => expect(screen.getByText(tc("computer.mode.needsYou.title"))).toBeTruthy());
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: true }));
    expect(await lastViewOnly()).toBe(false);
  });
  it("keeps an agent-held live screen readonly", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno", { controller: "agent" })] }),
      streamScreen,
    });
    renderPane(client);
    await waitFor(() => expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: false }));
    expect(await lastViewOnly()).toBe(true);
  });
  it("keeps a non-live user-held screen readonly with no control ticket", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({
        screens: [screenFor("agent-juno", { controller: "user", state: "starting" })],
      }),
      streamScreen,
    });
    renderPane(client);
    // The user holds this display, so the form offers Return — still disabled while starting.
    const returnControl = await screen.findByText(tc("computer.control.returnToAgent"));
    expect(returnControl.closest("button")?.disabled).toBe(true);
    expect(streamScreen).not.toHaveBeenCalled();
    expect(screen.queryByTestId("novnc-container")).toBeNull();
  });
  it("falls back to the mode for standalone consumers unless inputEnabled is set", async () => {
    render(
      <ComputerView
        computer={computer()}
        mode="needs-you"
        target={{ url: "wss://host/standalone" }}
      />,
    );
    expect(await lastViewOnly()).toBe(true);
  });
  it("honours an explicit inputEnabled override on a needs-you banner", async () => {
    render(
      <ComputerView
        computer={computer()}
        mode="needs-you"
        inputEnabled
        target={{ url: "wss://host/override" }}
      />,
    );
    expect(await lastViewOnly()).toBe(false);
  });
  it("keeps control mode interactive for standalone consumers", async () => {
    render(
      <ComputerView
        computer={computer()}
        mode="control"
        target={{ url: "wss://host/control" }}
      />,
    );
    expect(await lastViewOnly()).toBe(false);
  });

  it("refreshes the stream ticket under the current control and keeps the user interactive", async () => {
    const streamScreen = vi.fn(async () => ticket);
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno", { controller: "user" })] }),
      streamScreen,
    });
    renderPane(client);
    await waitFor(() =>
      expect(streamScreen).toHaveBeenCalledWith("screen-agent-juno", { control: true }),
    );
    expect(await lastViewOnly()).toBe(false);

    failLatestSurface();
    fireEvent.click(await reconnectButton());

    // The expired signed ticket is replaced under the CURRENT controller/control mode, not flipped.
    await waitFor(() => expect(streamScreen).toHaveBeenCalledTimes(2));
    expect(streamScreen).toHaveBeenLastCalledWith("screen-agent-juno", { control: true });
    expect(await lastViewOnly()).toBe(false);
  });

  it("reconnects onto the refreshed ticket URL instead of re-dialing the expired one", async () => {
    let call = 0;
    const streamScreen = vi.fn(async () => {
      call += 1;
      return call === 1 ? { ...ticket, url: "wss://host/expired" } : { ...ticket, url: "wss://host/fresh" };
    });
    const client = createLiveClient({
      computer: computer({ screens: [screenFor("agent-juno", { controller: "user" })] }),
      streamScreen,
    });
    renderPane(client);
    await waitFor(() => expect(rfbInstances.at(-1)?.url).toBe("wss://host/expired"));

    failLatestSurface();
    fireEvent.click(await reconnectButton());

    await waitFor(() => expect(rfbInstances.at(-1)?.url).toBe("wss://host/fresh"));
    expect(rfbInstances.filter((rfb) => rfb.url === "wss://host/expired")).toHaveLength(1);
  });
});
