import { createMockClient } from "@agent-desktop/test-fixtures";
import type { Agent, Conversation, Item, Run } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { ChatRow, latestMessageSummary } from "../../components/agent/ChatRow";
import { Composer } from "../../components/conversation/Composer";
import { ConversationView } from "../../components/conversation/ConversationView";
import { ClientProvider } from "../../data/ClientProvider";
import { t } from "../../lib/i18n";
import { UNKNOWN_USER } from "../../lib/people";
import { webPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { AppShell } from "../AppShell";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

const memoryStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => {
      map.set(name, value);
    },
    removeItem: (name: string) => {
      map.delete(name);
    },
  };
})();
useUiStore.persist.setOptions({ storage: createJSONStorage(() => memoryStorage) });

afterEach(cleanup);

const ISO = "2026-10-05T09:30:00.000Z";

function makeAgent(): Agent {
  return {
    id: "agent-juno",
    name: "Juno",
    handle: "juno",
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: "Research inbox",
    status: "idle",
    section: "Work",
    pinned: false,
    lastActivity: "Said hello",
    unreadCount: 0,
    model: {
      planner: { provider: "openai", model: "gpt" },
      computer: { provider: "openai", model: "gpt" },
      fast: { provider: "openai", model: "gpt" },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-juno",
    kind: "direct",
    title: "Juno",
    agentIds: ["agent-juno"],
    memberIds: ["member-robin"],
    unreadCount: 0,
    lastItemAt: ISO,
    createdAt: ISO,
    ...overrides,
  };
}

function renderShell(platform = webPlatform) {
  const client = createMockClient({ seed: 5 });
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} events={client} platform={platform}>
          <MemoryRouter initialEntries={["/c/conv-juno"]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="c/:conversationId" element={<div data-testid="conversation-sentinel" />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

function shellGroup(): HTMLElement {
  const group = document.querySelector('[data-slot="panel-group"]');
  if (!(group instanceof HTMLElement)) throw new Error("panel group not found");
  return group;
}

function shellColumns(): string {
  return shellGroup().style.gridTemplateColumns;
}

describe("UF6 reference shell grid", () => {
  it("lays out exactly three grid tracks with overlay separators, never separator tracks", () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
    renderShell();
    expect(shellGroup().style.display).toBe("grid");
    expect(shellColumns()).toBe("280px minmax(0, 1fr) 0px");
    const separators = Array.from(document.querySelectorAll('[data-slot="panel-separator"]'));
    expect(separators.length).toBeGreaterThan(0);
    for (const separator of separators) {
      if (!(separator instanceof HTMLElement)) throw new Error("separator not found");
      expect(separator.style.position).toBe("absolute");
    }
  });

  it("collapses the chat list to the 84px reference rail", () => {
    useUiStore.setState({ sidebarCollapsed: true, computerPanelOpen: false });
    renderShell();
    expect(shellColumns()).toBe("84px minmax(0, 1fr) 0px");
  });
  it("exposes separator values and controls for keyboard resizing", () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
    renderShell();
    const separator = document.querySelector('[aria-label="Resize chat list"]');
    if (!(separator instanceof HTMLElement)) throw new Error("separator not found");
    expect(separator.getAttribute("role")).toBe("separator");
    expect(separator.getAttribute("aria-valuemin")).toBe("84");
    expect(separator.getAttribute("aria-valuemax")).toBe("400");
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    expect(separator.getAttribute("aria-controls")).toBe("sidebar conversation");
  });

  it("draws the header at the shared header height with no run-status line", () => {
    const run: Run = {
      id: "run-1",
      agentId: "agent-juno",
      conversationId: "conv-juno",
      title: "Running...",
      status: "running",
      kind: "chat",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: ISO,
      lastActivityAt: ISO,
    };
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={createMockClient({ seed: 5 })}>
            <ConversationView
              conversation={makeConversation()}
              items={[]}
              itemsLoading={false}
              agents={[makeAgent()]}
              primaryAgent={makeAgent()}
              runningRuns={[run]}
              isLoading={false}
              isError={false}
              computerPanelOpen={false}
              onRetry={() => {}}
              onSend={() => {}}
              onToggleComputerPanel={() => {}}
              onOpenCitation={() => {}}
            />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    const header = document.querySelector("[data-titlebar]");
    if (!(header instanceof HTMLElement)) throw new Error("conversation header not found");
    expect(header.getAttribute("data-slot")).toBe("conversation-header");
    expect(header.className).toContain("h-[120px]");
    // UI82 removed the resting header hairline; UI91 gives the chat header its own 120px height
    // apart from the shared 52px shell rows, with no border.
    expect(header.className).not.toContain("border-b");
    expect(header.querySelector("p")).toBeNull();
    expect(header.textContent).not.toContain("Running");
  });
});

describe("UF6 red dot and message subtitle", () => {
  function renderRow(
    args: { needsYou?: number; unreadCount?: number; preview?: string; active?: boolean } = {},
  ) {
    const client = createMockClient({ seed: 5 });
    const onOpen = vi.fn();
    const onOpenComputer = vi.fn();
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} events={client} platform={webPlatform}>
            <ChatRow
              conversation={makeConversation({
                needsYou: args.needsYou ?? 0,
                unreadCount: args.unreadCount ?? 0,
                lastMessagePreview: args.preview,
              })}
              agents={[makeAgent()]}
              active={args.active}
              onOpen={onOpen}
              onOpenComputer={onOpenComputer}
            />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    return { onOpen, onOpenComputer };
  }

  function rowButton(): Element {
    const name = screen.getByText("Juno");
    const button = name.closest("button");
    if (!button) throw new Error("row button not found");
    return button;
  }

  it("shows a red dot button with no digits, split from the chat row", () => {
    renderRow({ needsYou: 3 });
    const dot = screen.getByTestId("chat-row-needs-you");
    expect(dot.tagName).toBe("BUTTON");
    expect(dot.textContent).toBe("");
    expect(dot.closest("button")).toBe(dot);
  });

  it("opens the computer from the dot and the chat from the row", () => {
    const { onOpen, onOpenComputer } = renderRow({ needsYou: 3 });
    fireEvent.click(screen.getByTestId("chat-row-needs-you"));
    expect(onOpenComputer).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(rowButton());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows a numeric unread badge (99+ capped) without pending requests", () => {
    const { onOpen } = renderRow({ unreadCount: 120 });
    expect(screen.getByTestId("chat-row-unread-badge").textContent).toBe("99+");
    expect(screen.queryByTestId("chat-row-needs-you")).toBeNull();
    fireEvent.click(rowButton());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders exactly one dot when pending requests and unread coincide", () => {
    renderRow({ needsYou: 3, unreadCount: 5 });
    // The needs-you button owns the avatar corner; the unread count is the badge beside the preview.
    const dot = screen.getByTestId("chat-row-needs-you");
    expect(dot.tagName).toBe("BUTTON");
    expect(dot.textContent).toBe("");
    expect(screen.queryByTestId("chat-row-unread-dot")).toBeNull();
  });

  it("reads \"Working\" in green while a run works in the chat", async () => {
    const client = createMockClient({ seed: 5 });
    const run = { id: "r1", agentId: "agent-juno", conversationId: "conv-juno", status: "running", title: "Task", steps: [] } as unknown as Run;
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} events={client} platform={webPlatform}>
            <ChatRow conversation={makeConversation()} agents={[makeAgent()]} working={run} onOpen={vi.fn()} />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    const subtitle = await screen.findByText(/^● Working/);
    expect(subtitle.className).toContain("text-success");
  });

  it("subtitles the newest message even when the stored preview is run state", async () => {
    const probe = createMockClient({ seed: 5 });
    const { items } = await probe.conversations.items("conv-juno");
    const expected = latestMessageSummary(items);
    if (!expected) throw new Error("seed conversation has no messages");
    renderRow({ needsYou: 3, preview: "Working · something" });
    expect(await screen.findByText(expected)).not.toBeNull();
    expect(screen.queryByText("Working · something")).toBeNull();
  });
});

describe("UF6 account menu", () => {
  function openProfileMenu() {
    fireEvent.keyDown(screen.getByRole("button", { name: UNKNOWN_USER.name }), {
      key: "ArrowDown",
    });
  }

  it("keeps the settings entry with a live localized callback through the compact menu", async () => {
    useUiStore.setState({ sidebarCollapsed: false, computerPanelOpen: false });
    renderShell(webPlatform);
    openProfileMenu();
    expect(await screen.findByText(t("nav.settings"))).not.toBeNull();
  });

  it("keeps Toolbox, Apps and Skills out of the tab bar and in the account menu, with no More submenu", async () => {
    useUiStore.setState({ sidebarCollapsed: false, computerPanelOpen: false });
    renderShell();
    expect(screen.queryByRole("button", { name: t("nav.toolbox") })).toBeNull();
    openProfileMenu();
    await screen.findByText(t("nav.settings"));
    expect(await screen.findByText(t("nav.toolbox"))).toBeTruthy();
    expect(await screen.findByText(t("nav.apps"))).toBeTruthy();
    expect(await screen.findByText(t("nav.skills"))).toBeTruthy();
    expect(screen.queryByText(t("chat.more"))).toBeNull();
  });
});

describe("UF6 coordinated motion", () => {
  it("arms the transition on the toggle render and retargets on the next frame", async () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
    renderShell();
    expect(shellColumns()).toBe("280px minmax(0, 1fr) 0px");
    expect(shellGroup().hasAttribute("data-animating")).toBe(false);
    await act(async () => {
      useUiStore.getState().toggleSidebar();
    });
    // Same render: the flag is armed while the tracks still hold their start values.
    expect(shellGroup().getAttribute("data-animating")).toBe("true");
    expect(shellColumns()).toBe("280px minmax(0, 1fr) 0px");
    // Next frame: the tracks retarget on the very same elements.
    const group = document.querySelector('[data-slot="panel-group"]');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(shellColumns()).toBe("84px minmax(0, 1fr) 0px");
    expect(document.querySelector('[data-slot="panel-group"]')).toBe(group);
  });

  it("renders settled tracks with no motion flag on initial mount", () => {
    useUiStore.setState({ sidebarCollapsed: true, computerPanelOpen: false });
    renderShell();
    expect(shellColumns()).toBe("84px minmax(0, 1fr) 0px");
    expect(shellGroup().hasAttribute("data-animating")).toBe(false);
  });

  it("keeps row and conversation nodes identical across the toggle", async () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
    renderShell();
    await waitFor(() => {
      if (!document.querySelector("aside ul li:first-child > div")) {
        throw new Error("waiting for sidebar rows");
      }
    });
    const row = document.querySelector("aside ul li:first-child > div");
    const conversation = document.querySelector('[data-testid="conversation-sentinel"]');
    if (!row || !conversation) throw new Error("shell content not found");
    await act(async () => {
      useUiStore.getState().toggleSidebar();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(document.querySelector("aside ul li:first-child > div")).toBe(row);
    expect(document.querySelector('[data-testid="conversation-sentinel"]')).toBe(conversation);
  });
});

describe("UF6 native traffic-light clearance", () => {
  const macPlatform = { ...webPlatform, id: "darwin", hasTrafficLights: true };

  it("renders the native collapsed rail at 96px with a shared-height traffic reserve", () => {
    useUiStore.setState({ sidebarCollapsed: true, computerPanelOpen: false });
    renderShell(macPlatform);
    expect(shellColumns()).toBe("96px minmax(0, 1fr) 0px");
    const separator = document.querySelector('[aria-label="Resize chat list"]');
    if (!(separator instanceof HTMLElement)) throw new Error("separator not found");
    expect(separator.getAttribute("aria-valuemin")).toBe("96");
    expect(separator.getAttribute("aria-valuenow")).toBe("96");
    // Stable geometry: one header stays mounted at fixed heights; collapsing only
    // fades the search field in place behind inert + aria-hidden, so no row below
    // moves when the rail opens or closes.
    const inner = document.querySelector('[data-slot="sidebar-inner"]');
    if (!(inner instanceof HTMLElement)) throw new Error("sidebar inner not found");
    expect(inner.getAttribute("data-collapsed")).toBe("true");
    const header = document.querySelector('[data-slot="sidebar-header"]');
    if (!(header instanceof HTMLElement)) throw new Error("sidebar header not found");
    // The shell's own top row holds the traffic-light clearance and the collapse
    // toggle, in both builds; the list's header holds only search and new-chat.
    const topbar = document.querySelector('[data-slot="shell-topbar"]');
    if (!(topbar instanceof HTMLElement)) throw new Error("shell topbar not found");
    expect(topbar.className).toContain("h-[var(--shell-header-height)]");
    const search = screen.getByPlaceholderText(t("sidebar.searchPlaceholder"));
    expect(search.closest("[inert]")).not.toBeNull();
    expect(search.closest("[inert]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reserves nothing on the web collapsed rail", () => {
    useUiStore.setState({ sidebarCollapsed: true, computerPanelOpen: false });
    renderShell();
    expect(shellColumns()).toBe("84px minmax(0, 1fr) 0px");
    // One nav tree in both states: the same five destination buttons stay mounted
    // and only their labels fade, so nothing mounts or unmounts on collapse.
    expect(document.querySelector('[data-slot="sidebar-rail-head"]')).toBeNull();
    expect(screen.getByRole("button", { name: /Show sidebar/u })).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="app-rail-item"]').length).toBe(5);
    const inner = document.querySelector('[data-slot="sidebar-inner"]');
    if (!(inner instanceof HTMLElement)) throw new Error("sidebar inner not found");
    expect(inner.getAttribute("data-collapsed")).toBe("true");
    const search = screen.getByPlaceholderText(t("sidebar.searchPlaceholder"));
    expect(search.closest("[inert]")).not.toBeNull();
    // One top row for both builds: the browser has no native traffic lights, so it
    // simply insets the first control.
    const topbar = document.querySelector('[data-slot="shell-topbar"]');
    if (!(topbar instanceof HTMLElement)) throw new Error("shell topbar not found");
  });
});

describe("UF6 selected and hover rows", () => {
  function renderActiveRow(args: { active?: boolean; collapsed?: boolean } = {}) {
    const client = createMockClient({ seed: 5 });
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} events={client} platform={webPlatform}>
            <ChatRow
              conversation={makeConversation()}
              agents={[makeAgent()]}
              active={args.active}
              collapsed={args.collapsed}
              onOpen={() => {}}
            />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
  }

  function rowShell(): HTMLElement {
    const name = screen.getByText("Juno");
    const button = name.closest("button");
    const shell = button?.parentElement;
    if (!(shell instanceof HTMLElement)) throw new Error("row shell not found");
    return shell;
  }

  it("highlights the open conversation row", () => {
    renderActiveRow({ active: true });
    expect(rowShell().className).toContain("bg-sidebar-accent");
  });

  it("highlights the open conversation on the collapsed rail too", () => {
    renderActiveRow({ active: true, collapsed: true });
    expect(rowShell().className).toContain("bg-sidebar-accent");
  });
});

describe("latestMessageSummary", () => {
  const user = (id: string, text: string): Item => ({
    id,
    conversationId: "conv-juno",
    at: ISO,
    type: "user_message",
    authorId: "member-1",
    text,
    attachments: [],
    mentions: [],
  });
  const agent = (id: string, markdown: string): Item => ({
    id,
    conversationId: "conv-juno",
    at: ISO,
    type: "agent_message",
    agentId: "agent-juno",
    markdown,
    citations: [],
  });
  const run = (id: string): Item => ({
    id,
    conversationId: "conv-juno",
    at: ISO,
    type: "run",
    runId: "run-1",
  });

  it("skips a trailing run for the newest message", () => {
    expect(latestMessageSummary([user("u1", "Hello"), run("r1")])).toBe("Hello");
  });

  it("uses the agent message first line", () => {
    expect(latestMessageSummary([agent("a1", "Done here\nsecond line"), run("r1")])).toBe(
      "Done here",
    );
  });

  it("returns undefined when nothing in range is a message", () => {
    expect(latestMessageSummary([run("r1")])).toBeUndefined();
  });
});


describe("UF6 composer controls", () => {
  function renderComposer(args: { running?: boolean; onStop?: () => void }) {
    const onSend = vi.fn();
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Composer agents={[]} onSend={onSend} running={args.running} onStop={args.onStop} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    return { onSend };
  }

  it("shows an enabled Stop only when running with a stop handler", () => {
    const onStop = vi.fn();
    renderComposer({ running: true, onStop });
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.hasAttribute("disabled")).toBe(false);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("never shows a Stop square without a stop handler, even when running", () => {
    renderComposer({ running: true });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
  });

  it("shows voice and send controls at idle, never Stop", () => {
    renderComposer({});
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("UF6 settled rail geometry", () => {
  function renderRailRow(args: { animating?: boolean; preview?: string } = {}) {
    const client = createMockClient({ seed: 5 });
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} events={client} platform={webPlatform}>
            <ChatRow
              conversation={makeConversation({ lastMessagePreview: args.preview })}
              agents={[makeAgent()]}
              collapsed
              animating={args.animating}
              onOpen={() => {}}
            />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
  }

  function railButton(): Element {
    const name = screen.getByText("Juno");
    const button = name.closest("button");
    if (!button) throw new Error("row button not found");
    return button;
  }

  it("centres the avatar with equal gutters and hides the text on the settled rail", () => {
    renderRailRow({ preview: "Hello there" });
    const button = railButton();
    if (!(button instanceof HTMLElement)) throw new Error("row button not found");
    // Continuous geometry: one layout in both modes, so the button keeps its
    // geometry and the 40px avatar drifts to centre through a CSS transform
    // while the text column fades in place instead of unmounting.
    expect(button.className).toContain("chat-row-button");
    expect(button.className).toContain("px-2");
    expect(button.className).not.toContain("justify-center");
    expect(button.getAttribute("aria-label")).toBe("Juno");
    const avatar = button.querySelector('[data-slot="chat-row-avatar"]');
    if (!(avatar instanceof HTMLElement)) throw new Error("row avatar not found");
    expect(avatar.className).toContain("chat-row-avatar");
    const textCol = button.querySelector('[data-slot="chat-row-text"]');
    if (!(textCol instanceof HTMLElement)) throw new Error("row text not found");
    expect(textCol.textContent).toContain("Juno");
    expect(textCol.className).toContain("opacity-0");
    expect(textCol.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the collapsed rail un-reflowed mid-animation", () => {
    renderRailRow({ animating: true, preview: "Hello there" });
    const button = railButton();
    if (!(button instanceof HTMLElement)) throw new Error("row button not found");
    // The legacy animating flag is ignored for geometry: the row follows the
    // collapsed state alone, so the mid-animation row matches the settled
    // rail with the same button geometry and faded text.
    expect(button.className).toContain("chat-row-button");
    expect(button.className).toContain("px-2");
    expect(button.className).not.toContain("justify-center");
    expect(button.getAttribute("aria-label")).toBe("Juno");
    const textCol = button.querySelector('[data-slot="chat-row-text"]');
    if (!(textCol instanceof HTMLElement)) throw new Error("row text not found");
    expect(textCol.textContent).toContain("Juno");
    expect(textCol.className).toContain("opacity-0");
    expect(textCol.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("UF6 collapsed footer", () => {
  it("shows the footer new-chat on the rail and hides the header one in place", () => {
    useUiStore.setState({ sidebarCollapsed: true, computerPanelOpen: false });
    renderShell();
    // The collapsed header keeps only the centred toggle; new-chat stays mounted
    // in both spots but only the footer's is reachable.
    const header = document.querySelector('[data-slot="sidebar-header"]');
    if (!(header instanceof HTMLElement)) throw new Error("sidebar header not found");
    const footer = document.querySelector('[data-slot="sidebar-footer"]');
    if (!(footer instanceof HTMLElement)) throw new Error("sidebar footer not found");
    const newchat = document.querySelector('[data-slot="sidebar-newchat"]');
    if (!(newchat instanceof HTMLElement)) throw new Error("footer new-chat not found");
    expect(newchat.hasAttribute("data-closed")).toBe(false);
    const buttons = screen.getAllByRole("button", { name: t("sidebar.newChat") });
    expect(buttons.length).toBe(1);
    const only = buttons[0];
    if (!only) throw new Error("new-chat button not found");
    expect(footer.contains(only)).toBe(true);
  });

  it("keeps new-chat on top when expanded", () => {
    useUiStore.setState({ sidebarCollapsed: false, computerPanelOpen: false });
    renderShell();
    expect(document.querySelector('[data-slot="shell-topbar"]')).not.toBeNull();
    const header = document.querySelector('[data-slot="sidebar-header"]');
    if (!(header instanceof HTMLElement)) throw new Error("sidebar header not found");
    // Expanded, the footer new-chat folds away behind inert while staying mounted.
    const newchat = document.querySelector('[data-slot="sidebar-newchat"]');
    if (!(newchat instanceof HTMLElement)) throw new Error("footer new-chat not found");
    expect(newchat.getAttribute("data-closed")).toBe("true");
    expect(newchat.querySelector("[inert]")).not.toBeNull();
    const buttons = screen.getAllByRole("button", { name: t("sidebar.newChat") });
    expect(buttons.length).toBe(1);
    const only = buttons[0];
    if (!only) throw new Error("new-chat button not found");
    expect(header.contains(only)).toBe(true);
  });
});

describe("UF6 settled footer geometry", () => {
  it("keeps one profile row with a mounted avatar in the app's icon rail", () => {
    useUiStore.setState({ sidebarCollapsed: true, computerPanelOpen: false });
    renderShell();
    const footer = document.querySelector('[data-slot="sidebar-footer"]');
    if (!(footer instanceof HTMLElement)) throw new Error("sidebar footer not found");
    expect(footer.className).toContain("px-2");
    // The signed-in account lives in the rail, in one place, in every build.
    const profile = screen.getByRole("button", { name: UNKNOWN_USER.name });
    const rail = document.querySelector('[data-slot="app-rail"]');
    if (!(rail instanceof HTMLElement)) throw new Error("app rail not found");
    expect(rail.contains(profile)).toBe(true);
    expect(profile.querySelector('[data-slot="account-avatar"]')).not.toBeNull();
  });

  it("keeps the rail's profile row when expanded", () => {
    useUiStore.setState({ sidebarCollapsed: false, computerPanelOpen: false });
    renderShell();
    const profile = screen.getByRole("button", { name: UNKNOWN_USER.name });
    expect(profile.querySelector('[data-slot="account-avatar"]')).not.toBeNull();
  });
});

