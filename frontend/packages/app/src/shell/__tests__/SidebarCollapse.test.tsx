import { createMockClient } from "@agent-desktop/test-fixtures";
import type { Agent, Conversation } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { ClientProvider } from "../../data/ClientProvider";
import { t } from "../../lib/i18n";
import { webPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { AppShell } from "../AppShell";
import { SidebarList } from "../sidebar/SidebarList";
import { CHAT_FILTERS } from "../sidebar/chatEntries";
import type { ChatEntry } from "../sidebar/chatEntries";

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

function renderShell() {
  const client = createMockClient({ seed: 5 });
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} events={client} platform={webPlatform}>
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

function navButtons(): Element[] {
  // The destinations live in the app's icon rail, not in the chat list: one
  // navigation tree for the whole shell, in every build.
  return Array.from(document.querySelectorAll('[data-slot="app-rail-item"]'));
}

function filterChips(): Element[] {
  const group = document.querySelector('[data-slot="sidebar-recents-chrome"] [role="group"]');
  if (!group) throw new Error("filter group not found");
  return Array.from(group.querySelectorAll("button"));
}

describe("sidebar collapse keeps one mounted tree", () => {
  it("reuses the same header, nav, chrome, filter, row and footer nodes across collapse and expand", async () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
    renderShell();
    await waitFor(() => {
      if (!document.querySelector("aside ul li:first-child > div")) {
        throw new Error("waiting for sidebar rows");
      }
    });
    // No duplicated rail tree: exactly one nav, header new-chat reachable when expanded.
    expect(document.querySelector('[data-slot="sidebar-rail-head"]')).toBeNull();
    expect(document.querySelector('[data-slot="rail-nav"]')).toBeNull();
    expect(navButtons().length).toBe(5);
    const header = document.querySelector('[data-slot="sidebar-header"]');
    if (!(header instanceof HTMLElement)) throw new Error("sidebar header not found");
    const footerNode = document.querySelector('[data-slot="sidebar-footer"]');
    if (!(footerNode instanceof HTMLElement)) throw new Error("sidebar footer not found");
    const newChat = screen.getByRole("button", { name: t("sidebar.newChat") });
    expect(header.contains(newChat)).toBe(true);

    const before = {
      header,
      nav: navButtons(),
      chrome: document.querySelector('[data-slot="sidebar-recents-chrome"]'),
      chips: filterChips(),
      row: document.querySelector("aside ul li:first-child > div"),
      footer: document.querySelector('[data-slot="sidebar-footer"]'),
    };
    expect(before.chrome).not.toBeNull();
    expect(before.chips.length).toBe(CHAT_FILTERS.length);

    await act(async () => {
      useUiStore.getState().toggleSidebar();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // Collapsed: the same nodes, nothing remounted; the chrome folds its height
    // away behind inert + aria-hidden while the footer new-chat opens.
    expect(document.querySelector('[data-slot="sidebar-header"]')).toBe(before.header);
    expect(navButtons()).toEqual(before.nav);
    const chrome = document.querySelector('[data-slot="sidebar-recents-chrome"]');
    expect(chrome).toBe(before.chrome);
    if (!(chrome instanceof HTMLElement)) throw new Error("recents chrome not found");
    expect(chrome.getAttribute("data-closed")).toBe("true");
    expect(chrome.querySelector("[inert]")).not.toBeNull();
    expect(filterChips()).toEqual(before.chips);
    expect(document.querySelector("aside ul li:first-child > div")).toBe(before.row);
    expect(document.querySelector('[data-slot="sidebar-footer"]')).toBe(before.footer);
    // New-chat hands over: still exactly one reachable, now the footer's.
    const collapsedNewChat = screen.getAllByRole("button", { name: t("sidebar.newChat") });
    expect(collapsedNewChat.length).toBe(1);
    expect(before.footer?.contains(collapsedNewChat[0] as Node)).toBe(true);

    await act(async () => {
      useUiStore.getState().toggleSidebar();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // Expanded again: still the same nodes, chrome reachable once more.
    expect(document.querySelector('[data-slot="sidebar-header"]')).toBe(before.header);
    expect(navButtons()).toEqual(before.nav);
    expect(filterChips()).toEqual(before.chips);
    expect(document.querySelector("aside ul li:first-child > div")).toBe(before.row);
    const reopened = document.querySelector('[data-slot="sidebar-recents-chrome"]');
    if (!(reopened instanceof HTMLElement)) throw new Error("recents chrome not found");
    expect(reopened.hasAttribute("data-closed")).toBe(false);
    expect(screen.getByRole("button", { name: t("sidebar.newChat") })).toBeTruthy();
  });

  it("keeps the Recents filter working across the toggle", async () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280, computerPanelOpen: false });
    renderShell();
    await waitFor(() => {
      if (filterChips().length !== CHAT_FILTERS.length) throw new Error("waiting for filter chips");
    });
    const unreadChip = filterChips()[1];
    if (!(unreadChip instanceof HTMLElement)) throw new Error("unread chip not found");
    fireEvent.click(unreadChip);
    expect(unreadChip.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      useUiStore.getState().toggleSidebar();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    // The selection survives the collapse on the same mounted chip.
    expect(filterChips()).toContain(unreadChip);
    expect(unreadChip.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("pinned grouping lifecycle", () => {
  function Harness({ pinnedIds, collapsed }: { pinnedIds: string[]; collapsed: boolean }) {
    const client = useMemo(() => createMockClient({ seed: 5 }), []);
    const [base, setBase] = useState<Conversation | null>(null);
    const [agents, setAgents] = useState<Agent[]>([]);
    useEffect(() => {
      let live = true;
      void (async () => {
        const conversations = (await client.conversations.list()).items;
        const list = (await client.agents.list()).items;
        if (live) {
          setBase(conversations[0] as Conversation);
          setAgents(list);
        }
      })();
      return () => {
        live = false;
      };
    }, [client]);
    if (!base) return null;
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    // Production order arrives pinned-first (buildChatEntries sorts it there).
    const ordered = ["Starred chat", "Other A", "Other B"].map((title, index) => {
      const id = `conv-group-${index}`;
      return {
        conversation: { ...base, id, title, pinned: pinnedIds.includes(id) },
        agents,
        name: title,
      };
    });
    const entries = [...ordered].sort(
      (a, b) => Number(b.conversation.pinned) - Number(a.conversation.pinned),
    );
    const noop = () => {};
    return (
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} events={client} platform={webPlatform}>
            <SidebarList
              entries={entries}
              activeId={undefined}
              collapsed={collapsed}
              composeRecipients={[]}
              agentById={agentById}
              onCompose={false}
              onOpen={noop}
              onOpenComputer={noop}
              onTogglePin={noop}
              onMarkRead={noop}
              onProfile={noop}
              onRenameEntry={noop}
              onDeleteEntry={noop}
              onMute={noop}
              onOpenDraft={noop}
            />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  function rowLi(title: string): HTMLElement {
    const hit = Array.from(document.querySelectorAll('[data-slot="sidebar-recents"] li')).find((li) =>
      li.querySelector('[data-slot="chat-row-text"]')?.textContent?.includes(title),
    );
    if (!(hit instanceof HTMLElement)) throw new Error(`missing row for ${title}`);
    return hit;
  }

  function headings(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll('[data-slot="sidebar-group-heading"]'),
    ).filter((node): node is HTMLElement => node instanceof HTMLElement);
  }

  it("groups only while pinned exist and reuses the same row nodes through pin, collapse and unpin", async () => {
    const view = render(<Harness pinnedIds={[]} collapsed={false} />);
    await waitFor(() => {
      if (document.querySelectorAll('[data-slot="sidebar-recents"] li').length !== 3) {
        throw new Error("waiting for rows");
      }
    });
    // No pinned: continuous list, no section headings.
    expect(headings().length).toBe(0);
    expect(document.querySelectorAll('[data-slot="sidebar-recents"] li').length).toBe(3);
    const starred = rowLi("Starred chat");
    const otherA = rowLi("Other A");

    // Pin: Pinned + Other chats markers wrap the same mounted rows, pinned first.
    view.rerender(<Harness pinnedIds={["conv-group-0"]} collapsed={false} />);
    await waitFor(() => {
      if (headings().length !== 2) throw new Error("waiting for group headings");
    });
    expect(headings()[0]?.textContent).toContain(t("sidebar.pinned"));
    expect(headings()[1]?.textContent).toContain(t("sidebar.otherChats"));
    const items = Array.from(document.querySelectorAll('[data-slot="sidebar-recents"] li'));
    expect(items.length).toBe(5);
    expect(items[1]).toBe(starred);
    expect(rowLi("Starred chat")).toBe(starred);
    expect(rowLi("Other A")).toBe(otherA);

    // Collapse: headings fold away with no ghost gap, rows keep their nodes.
    view.rerender(<Harness pinnedIds={["conv-group-0"]} collapsed />);
    await waitFor(() => {
      if (headings()[0]?.getAttribute("data-closed") !== "true") {
        throw new Error("waiting for folded headings");
      }
    });
    for (const heading of headings()) {
      expect(heading.querySelector("[inert]")).not.toBeNull();
    }
    expect(rowLi("Starred chat")).toBe(starred);
    expect(rowLi("Other A")).toBe(otherA);

    // Unpin: headings disappear, the continuous list reuses the same row nodes.
    view.rerender(<Harness pinnedIds={[]} collapsed={false} />);
    await waitFor(() => {
      if (headings().length !== 0) throw new Error("waiting for headings to clear");
    });
    expect(document.querySelectorAll('[data-slot="sidebar-recents"] li').length).toBe(3);
    expect(rowLi("Starred chat")).toBe(starred);
    expect(rowLi("Other A")).toBe(otherA);
  });
});

describe("sidebar list cap is collapse-independent", () => {
  async function renderList(collapsed: boolean) {
    const client = createMockClient({ seed: 5 });
    const conversations = (await client.conversations.list()).items;
    const base = conversations[0] as Conversation;
    const agents = (await client.agents.list()).items as Agent[];
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const entries: ChatEntry[] = Array.from({ length: 25 }, (_, index) => {
      const conversation = { ...base, id: `conv-cap-${index}`, title: `Chat ${index}` };
      return { conversation, agents, name: `Chat ${index}` };
    });
    const noop = () => {};
    const view = render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} events={client} platform={webPlatform}>
            <SidebarList
              entries={entries}
              activeId={undefined}
              collapsed={collapsed}
              composeRecipients={[{ key: "draft-1", kind: "agent", agentId: agents[0]?.id, name: agents[0]?.name ?? "Draft" }]}
              agentById={agentById}
              onCompose={false}
              onOpen={noop}
              onOpenComputer={noop}
              onTogglePin={noop}
              onMarkRead={noop}
              onProfile={noop}
              onRenameEntry={noop}
              onDeleteEntry={noop}
              onMute={noop}
              onOpenDraft={noop}
            />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    return view;
  }

  it("shows the same capped rows and keeps chrome and draft mounted in both states", async () => {
    const expanded = await renderList(false);
    await waitFor(() => {
      if (expanded.container.querySelectorAll('[data-slot="sidebar-recents"] li').length === 0) {
        throw new Error("waiting for capped rows");
      }
    });
    expect(expanded.container.querySelectorAll('[data-slot="sidebar-recents"] li').length).toBe(20);
    const chrome = expanded.container.querySelector('[data-slot="sidebar-recents-chrome"]');
    expect(chrome).not.toBeNull();
    expect(expanded.container.querySelectorAll('[role="group"] button').length).toBe(CHAT_FILTERS.length);
    expanded.unmount();
    cleanup();

    const collapsed = await renderList(true);
    await waitFor(() => {
      if (collapsed.container.querySelectorAll('[data-slot="sidebar-recents"] li').length === 0) {
        throw new Error("waiting for capped rows");
      }
    });
    // Collapsing must not expose the full list: same 20 capped rows either way.
    expect(collapsed.container.querySelectorAll('[data-slot="sidebar-recents"] li').length).toBe(20);
    const collapsedChrome = collapsed.container.querySelector('[data-slot="sidebar-recents-chrome"]');
    expect(collapsedChrome).not.toBeNull();
    expect(collapsedChrome?.getAttribute("data-closed")).toBe("true");
    expect(collapsedChrome?.querySelector("[inert]")).not.toBeNull();
    // The draft stays mounted and only fades its labels to the avatar.
    const draft = screen.getByRole("button", { name: t("compose.draftTitle") });
    expect(draft).toBeTruthy();
  });
});
