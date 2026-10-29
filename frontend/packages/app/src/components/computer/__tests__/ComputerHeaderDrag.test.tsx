import {
  type ApiClient,
  type Computer,
  type ScreenResponse,
  type ScreenStreamTicket,
} from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { dragRegion, noDragRegion } from "../../../lib/drag";
import { ComputerPane } from "../ComputerPane";
import { tc } from "../i18n";

// Same jsdom shims as the pane suites: noVNC cannot open a websocket here, and the ui
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

type ScreenT = NonNullable<Computer["screens"]>[number];

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

function toScreen(computerId: string, s: ScreenT): ScreenResponse {
  return {
    ...s,
    ownerId: "user-robin",
    computerId,
    controlEpoch: 0,
    resolution: "1364x1024",
    lastUsedAt: ISO,
  };
}

const ticket: ScreenStreamTicket = {
  url: "wss://127.0.0.1:8787/v1/screens/screen-agent-juno/vnc?t=t-juno",
  expiresAt: "2026-10-05T09:35:00.000Z",
};

function createLiveClient(comp: Computer): ApiClient {
  const base = createMockClient({ seed: 3 });
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: [comp], nextCursor: null }),
    get: async () => comp,
    screens: async () => ({
      items: (comp.screens ?? []).map((s) => toScreen(comp.id, s)),
      nextCursor: null,
    }),
    screen: async (_computerId, agentId) => {
      const found = comp.screens?.find((s) => s.agentId === agentId);
      return found ? toScreen(comp.id, found) : null;
    },
    allocateScreen: async (_computerId, agentId) => toScreen(comp.id, screenFor(agentId)),
    streamScreen: async () => ticket,
    screenshot: async () => ({ data: "x", mimeType: "image/png" }),
    takeOverScreen: async () => toScreen(comp.id, screenFor("agent-juno")),
    returnControlScreen: async () => toScreen(comp.id, screenFor("agent-juno")),
  };
  return { ...base, mode: "live", computers };
}

function createNoComputerClient(overrides: Partial<ApiClient["computers"]> = {}): ApiClient {
  const base = createMockClient({ seed: 3 });
  const computers: ApiClient["computers"] = {
    ...base.computers,
    list: async () => ({ items: [], nextCursor: null }),
    ensure: () => new Promise<Computer>(() => {}),
    screens: async () => ({ items: [], nextCursor: null }),
    screen: async () => null,
    ...overrides,
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

/** The single inspectable header row the pane renders in every lifecycle branch. */
function headerOf(container: HTMLElement): HTMLElement {
  const header = container.querySelector('[data-slot="computer-header"]');
  if (!(header instanceof HTMLElement)) throw new Error("computer header missing");
  return header;
}

/** The blank spacer: the flex-1 span covering the header's empty middle. */
function spacerOf(header: HTMLElement): HTMLElement {
  const spacer = header.querySelector("span.min-w-0");
  if (!(spacer instanceof HTMLElement)) throw new Error("computer header spacer missing");
  return spacer;
}

/**
 * DOM-level contract only (headless). jsdom drops `-webkit-app-region` from inline
 * styles, so the drag/no-drag style wiring itself is pinned by
 * `scripts/verify/computer-header-drag.mjs`; what headless DOM can prove is the
 * structure that wiring depends on: one inspectable header row with the conversation
 * header tokens (one shared 52px token row, same px-3 insets), and a blank spacer
 * carrying no style of its own, so no invisible no-drag wrapper covers it and the
 * empty middle keeps inheriting the header drag. Whether the OS shell actually moves
 * the window is platform acceptance, not claimed here.
 */
function expectDragContract(header: HTMLElement): void {
  // The exact style objects the headers/controls apply.
  expect(dragRegion).toEqual({ WebkitAppRegion: "drag" });
  expect(noDragRegion).toEqual({ WebkitAppRegion: "no-drag" });
  // Same row tokens as the conversation header: one 52px token row, same px-3 insets.
  expect(header.className).toContain("h-[var(--shell-header-height)]");
  expect(header.className).toContain("px-3");
  // The spacer covers the blank middle and opts out of nothing itself.
  expect(spacerOf(header).getAttribute("style")).toBeNull();
  // The interactive header buttons are present and enabled in this branch.
  const settings = header.querySelector(`[aria-label="${tc("computer.action.settings")}"]`);
  if (!(settings instanceof HTMLElement)) throw new Error("computer header settings missing");
  expect(settings.closest("button")?.disabled).toBeFalsy();
}

describe("ComputerPane header native drag", () => {
  it("no-computer header exposes the shared slot with a bare draggable spacer", async () => {
    const { container } = renderPane(createNoComputerClient());

    await waitFor(() => expect(screen.getByText(tc("computer.noComputerHint"))).toBeTruthy());
    expectDragContract(headerOf(container));
    // Header access survives the missing machine.
    expect(screen.getByLabelText(tc("computer.action.settings"))).toBeTruthy();
    expect(screen.getByLabelText(tc("computer.action.close"))).toBeTruthy();
  });

  it("loading header keeps the same slot and spacer before the machine resolves", async () => {
    const { container } = renderPane(
      createNoComputerClient({ list: () => new Promise<{ items: []; nextCursor: null }>(() => {}) }),
    );

    await waitFor(() => expect(screen.getByText(tc("computer.ensure.pending"))).toBeTruthy());
    expectDragContract(headerOf(container));
  });

  it("live header keeps the slot and spacer with the screen controls working", async () => {
    const { container } = renderPane(
      createLiveClient(computer({ screens: [screenFor("agent-juno")] })),
    );

    await waitFor(() => expect(screen.getByText(tc("computer.takeOver"))).toBeTruthy());
    expectDragContract(headerOf(container));
  });

  it("group header wraps only the switcher button, never the spacer", async () => {
    const { container } = renderPane(
      createLiveClient(
        computer({ screens: [screenFor("agent-juno"), screenFor("agent-patch")] }),
      ),
      "agent-juno",
      "conv-launch",
    );

    await waitFor(() =>
      expect(screen.getByLabelText(tc("computer.screen.pick"))).toBeTruthy(),
    );
    const header = headerOf(container);
    expectDragContract(header);
    // The switcher is interactive, so it sits under its own tight wrapper: that wrapper
    // holds exactly the one button, proving no broad no-drag element covers the spacer.
    const picker = screen.getByLabelText(tc("computer.screen.pick"));
    if (!(picker instanceof HTMLElement)) throw new Error("screen picker missing");
    const wrapper = picker.parentElement;
    if (!(wrapper instanceof HTMLElement)) throw new Error("screen switcher wrapper missing");
    expect(wrapper.children.length).toBe(1);
    expect(spacerOf(header).getAttribute("style")).toBeNull();
  });

  it("allocation-error header keeps the slot and spacer with the retry visible", async () => {
    const { container } = renderPane(
      createNoComputerClient({
        ensure: async () => {
          throw new Error("allocation failed");
        },
      }),
    );

    await waitFor(() => expect(screen.getByText(tc("computer.ensure"))).toBeTruthy());
    expectDragContract(headerOf(container));
  });
});
