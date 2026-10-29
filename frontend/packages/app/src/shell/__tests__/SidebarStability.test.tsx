import type { Conversation } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { ClientProvider } from "../../data/ClientProvider";
import { qk } from "../../data/keys";
import { webPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { AppShell } from "../AppShell";

// Exercise the shell seam with actual queries; screen rendering belongs to FS2.
vi.mock("../ComputerPaneSlot", () => ({
  ComputerPaneSlot: ({ agentId, conversationId }: { agentId: string; conversationId: string }) => (
    <div data-testid="computer-identity" data-agent={agentId} data-conversation={conversationId} />
  ),
}));

const storageValues = new Map<string, string>();
useUiStore.persist.setOptions({ storage: createJSONStorage(() => ({
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageValues.set(key, value); },
  removeItem: (key: string) => { storageValues.delete(key); },
})) });

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Observer);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  useUiStore.setState({ ...useUiStore.getInitialState(), sidebarCollapsed: true });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

function Navigation() {
  const navigate = useNavigate();
  return <div>{["conv-juno", "cold-one", "cold-two", "empty", "unknown", "new"].map((id) => (
    <button key={id} onClick={() => navigate(id === "new" ? "/new" : `/c/${id}`)}>Visit {id}</button>
  ))}</div>;
}

function delayedConversation() {
  let resolve: (conversation: Conversation) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<Conversation>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function mount(hasTrafficLights = false) {
  const client = createMockClient({ seed: 5 });
  const conversations = (await client.conversations.list()).items;
  const juno = conversations.find((entry) => entry.id === "conv-juno");
  if (!juno) throw new Error("missing Juno fixture");
  const one = { ...juno, id: "cold-one", title: "Cold one", agentIds: ["agent-one"] };
  const two = { ...juno, id: "cold-two", title: "Cold two", agentIds: ["agent-two"] };
  const empty = { ...juno, id: "empty", title: "No agent", agentIds: [] };
  const pendingOne = delayedConversation();
  const pendingTwo = delayedConversation();
  const pendingEmpty = delayedConversation();
  const pendingUnknown = delayedConversation();
  const originalGet = client.conversations.get;
  client.conversations.get = (id) => {
    if (id === one.id) return pendingOne.promise;
    if (id === two.id) return pendingTwo.promise;
    if (id === empty.id) return pendingEmpty.promise;
    if (id === "unknown") return pendingUnknown.promise;
    return originalGet(id);
  };
  const list = [...conversations, one, two, empty];
  client.conversations.list = async () => ({ items: list, nextCursor: null });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(queryClient);
  queryClient.setQueryData(qk.conversations(), list);
  queryClient.setQueryData(qk.conversation(juno.id), juno);
  queryClient.setQueryData(qk.agents(), (await client.agents.list()).items);
  render(
    <ThemeProvider defaultTheme="dark"><TooltipProvider>
      <ClientProvider client={client} queryClient={queryClient} platform={{ ...webPlatform, hasTrafficLights }}>
        <MemoryRouter initialEntries={["/c/conv-juno"]}>
          <Navigation />
          <Routes><Route element={<AppShell />}>
            <Route path="c/:conversationId" element={<div data-testid="conversation-sentinel" />} />
            <Route path="new" element={<div>New chat</div>} />
          </Route></Routes>
        </MemoryRouter>
      </ClientProvider>
    </TooltipProvider></ThemeProvider>,
  );
  await screen.findByRole("button", { name: "Juno" });
  return { one, two, empty, pendingOne, pendingTwo, pendingEmpty, pendingUnknown, queryClient };
}

function shell() {
  const root = document.querySelector("#shell");
  if (!(root instanceof HTMLElement)) throw new Error("missing shell");
  return root;
}

 function rail(width = 84) {
   const inner = document.querySelector("#sidebar > aside > div");
   if (!(inner instanceof HTMLElement)) throw new Error("missing sidebar content");
   // Continuous geometry: the inner column always fills the live track, so the
   // track carries the rail width and the row background is never clipped.
   expect(inner.style.width).toBe("100%");
   expect(inner.getAttribute("data-slot")).toBe("sidebar-inner");
   expect(inner.getAttribute("data-collapsed")).toBe("true");
   expect(shell().style.gridTemplateColumns.startsWith(`${width}px`)).toBe(true);
   const row = screen.getByRole("button", { name: "Juno" });
   const rowBox = row.closest('[data-slot="chat-row"]');
   if (!(rowBox instanceof HTMLElement)) throw new Error("missing chat row");
   expect(rowBox.getAttribute("data-collapsed")).toBe("true");
   // One layout in both modes: the button keeps its geometry while the text fades
   // inside the row, so there is no centering swap when motion settles.
   expect(row.className).toContain("chat-row-button");
   expect(row.className).not.toContain("justify-center");
    const text = rowBox.querySelector('[data-slot="chat-row-text"]');
    expect(text?.className).toContain("opacity-0");
    // Stable footer in both states: the rail's new-chat. The signed-in account
    // sits in the app's icon rail, so the list does not repeat it.
    const footer = document.querySelector('[data-slot="sidebar-footer"]');
    expect(footer?.className).toContain("px-2");
    const footerButtons = footer ? Array.from(footer.querySelectorAll("button")) : [];
    expect(footerButtons.length).toBe(1);
    const newChat = footerButtons[0];
    if (!newChat) throw new Error("missing new-chat row");
    return { inner, row, avatar: row.querySelector("svg,img"), footer };
 }

describe("sidebar and route stability", () => {
  it("keeps native rail, row, avatar and conversation nodes unchanged through rapid panel-only toggles", async () => {
    useUiStore.setState({ computerPanelOpen: false });
    await mount(true);
    const before = rail(96);
    const conversation = screen.getByTestId("conversation-sentinel");
    conversation.scrollTop = 123;
    for (const open of [true, false, true, false, true]) {
      act(() => useUiStore.getState().setComputerPanelOpen(open));
      expect(rail(96)).toEqual(before);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
      expect(rail(96)).toEqual(before);
    }
    await waitFor(() => expect(shell().getAttribute("data-animating")).toBeNull());
    expect(screen.getByTestId("conversation-sentinel")).toBe(conversation);
    expect(conversation.scrollTop).toBe(123);
  });

  it("uses only the destination list identity through multiple delayed detail queries", async () => {
    const fixture = await mount();
    const before = rail();
    const columns = shell().style.gridTemplateColumns;
    const conversation = screen.getByTestId("conversation-sentinel");
    fireEvent.click(screen.getByRole("button", { name: "Visit cold-one" }));
    expect(screen.getByTestId("computer-identity").getAttribute("data-agent")).toBe("agent-one");
    expect(shell().style.gridTemplateColumns).toBe(columns);
    expect(shell().getAttribute("data-animating")).toBeNull();
    expect(rail()).toEqual(before);
    fireEvent.click(screen.getByRole("button", { name: "Visit cold-two" }));
    expect(screen.getByTestId("computer-identity").getAttribute("data-agent")).toBe("agent-two");
    await act(async () => fixture.pendingOne.resolve(fixture.one));
    expect(screen.getByTestId("computer-identity").getAttribute("data-agent")).toBe("agent-two");
    await act(async () => fixture.pendingTwo.resolve(fixture.two));
    expect(shell().style.gridTemplateColumns).toBe(columns);
    expect(shell().getAttribute("data-animating")).toBeNull();
    expect(rail()).toEqual(before);
    expect(screen.getByTestId("conversation-sentinel")).toBe(conversation);
  });

  it("does not retain a previous agent for an empty list identity or a new-chat route", async () => {
    const fixture = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Visit empty" }));
    expect(screen.queryByTestId("computer-identity")).toBeNull();
    await act(async () => fixture.pendingEmpty.resolve(fixture.empty));
    expect(screen.queryByTestId("computer-identity")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Visit conv-juno" }));
    expect(screen.getByTestId("computer-identity").getAttribute("data-agent")).toBe("agent-juno");
    fireEvent.click(screen.getByRole("button", { name: "Visit new" }));
    expect(screen.queryByTestId("computer-identity")).toBeNull();
  });

  it("hides unknown routes and failed detail queries instead of using stale screen identity", async () => {
    const fixture = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Visit unknown" }));
    expect(screen.queryByTestId("computer-identity")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Visit cold-one" }));
    expect(screen.getByTestId("computer-identity").getAttribute("data-agent")).toBe("agent-one");
    await act(async () => fixture.pendingOne.reject(new Error("conversation unavailable")));
    await waitFor(() => expect(screen.queryByTestId("computer-identity")).toBeNull());
    expect(useUiStore.getState().computerPanelOpen).toBe(true);
  });

  it("keeps manual expanded geometry on a cold navigation without rewriting preferences", async () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 330 });
    const fixture = await mount();
    act(() => useUiStore.getState().toggleSidebar());
    await waitFor(() => expect(shell().style.gridTemplateColumns.startsWith("330px")).toBe(true));
    await waitFor(() => expect(shell().getAttribute("data-animating")).toBeNull());
    const row = screen.getByText("Juno", { selector: '[data-slot="chat-row"] span' }).closest("button");
    const avatar = row?.querySelector("svg,img");
    fireEvent.click(screen.getByRole("button", { name: "Visit cold-one" }));
    expect(shell().style.gridTemplateColumns.startsWith("330px")).toBe(true);
    expect(shell().getAttribute("data-animating")).toBeNull();
    await act(async () => fixture.pendingOne.resolve(fixture.one));
    expect(screen.getByText("Juno", { selector: '[data-slot="chat-row"] span' }).closest("button")).toBe(row);
    expect(row?.querySelector("svg,img")).toBe(avatar);
    expect(useUiStore.getState()).toMatchObject({ sidebarCollapsed: false, sidebarSize: 330 });
  });

  it("still stages genuine sidebar collapse/expand and preserves row and avatar nodes", async () => {
    useUiStore.setState({ computerPanelOpen: false });
    await mount();
    const before = rail();
    act(() => useUiStore.getState().toggleSidebar());
    expect(shell().getAttribute("data-animating")).toBe("true");
    expect(before.inner.style.width).toBe("100%");
    await waitFor(() => expect(shell().style.gridTemplateColumns.startsWith("280px")).toBe(true));
    expect(screen.getByText("Juno", { selector: '[data-slot="chat-row"] span' }).closest("button")).toBe(before.row);
    expect(before.row.querySelector("svg,img")).toBe(before.avatar);
    act(() => useUiStore.getState().toggleSidebar());
    await waitFor(() => expect(shell().getAttribute("data-animating")).toBeNull());
    expect(rail().inner).toBe(before.inner);
    expect(rail().row).toBe(before.row);
    expect(rail().avatar).toBe(before.avatar);
  });
});
