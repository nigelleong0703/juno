import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { ClientProvider } from "../../data/ClientProvider";
import { webPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { AppShell } from "../AppShell";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};
useUiStore.persist.setOptions({ storage: createJSONStorage(() => storage) });

let observedResize: (() => void) | undefined;
class Observer {
  constructor(callback: () => void) { observedResize = callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function resize(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  fireEvent(window, new Event("resize"));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Observer);
  observedResize = undefined;
  resize(953);
  useUiStore.setState({ ...useUiStore.getInitialState(), sidebarCollapsed: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(hasTrafficLights = false) {
  const client = createMockClient({ seed: 5 });
  render(
    <ThemeProvider defaultTheme="dark"><TooltipProvider>
      <ClientProvider client={client} events={client} platform={{ ...webPlatform, hasTrafficLights }}>
        <MemoryRouter initialEntries={["/c/conv-juno"]}><Routes>
          <Route element={<AppShell />}>
            <Route path="c/:conversationId" element={<div data-testid="chat-sentinel" />} />
          </Route>
        </Routes></MemoryRouter>
      </ClientProvider>
    </TooltipProvider></ThemeProvider>,
  );
  return screen.findByRole("separator", { name: "Resize computer pane" });
}

function tracks() {
  const shell = document.querySelector("#shell");
  if (!(shell instanceof HTMLElement)) throw new Error("missing shell");
  const columns = shell.style.gridTemplateColumns.split(" ");
  return { sidebar: Number(columns[0]?.replace("px", "")), computer: Number(columns.at(-1)?.replace("px", "")) };
}

describe("computer width within the shell", () => {
  it("fits the larger default on a wide window and restores it after a narrow viewport", async () => {
    resize(1440);
    await mount();
    await waitFor(() => expect(tracks().computer).toBe(860));
    const chat = screen.getByTestId("chat-sentinel");
    act(() => resize(512));
    expect(tracks()).toEqual({ sidebar: 84, computer: 148 });
    expect(tracks().sidebar + tracks().computer + 280).toBe(512);
    expect(useUiStore.getState().computerPaneSize).toBe(860);
    act(() => resize(1440));
    expect(tracks().computer).toBe(860);
    expect(screen.getByTestId("chat-sentinel")).toBe(chat);
  });

  it("keeps the shipped default prominent on ultrawide windows", async () => {
    resize(2160);
    await mount();
    await waitFor(() => expect(tracks().computer).toBe(1287));
    expect(tracks().computer / (2160 - tracks().sidebar)).toBeGreaterThanOrEqual(0.6);
    act(() => resize(3120));
    expect(tracks().computer).toBe(1882);
    expect(tracks().computer / (3120 - tracks().sidebar)).toBeGreaterThanOrEqual(0.6);
    expect(useUiStore.getState().computerPaneSize).toBe(860);
  });

  it("keeps a custom width exact on an ultrawide window", async () => {
    useUiStore.setState({ computerPaneSize: 800 });
    resize(3120);
    await mount();
    await waitFor(() => expect(tracks().computer).toBe(800));
    expect(useUiStore.getState().computerPaneSize).toBe(800);
  });

  it("clamps an oversized preference and restores it on widening without persisting a resize", async () => {
    useUiStore.setState({ computerPaneSize: 800 });
    const divider = await mount();
    await waitFor(() => expect(tracks().computer).toBe(589));
    const chat = screen.getByTestId("chat-sentinel");
    act(() => resize(750));
    expect(tracks().computer).toBe(386);
    expect(divider.getAttribute("aria-valuemin")).toBe("386");
    expect(useUiStore.getState().computerPaneSize).toBe(800);
    act(() => resize(1440));
    expect(tracks().computer).toBe(800);
    expect(screen.getByTestId("chat-sentinel")).toBe(chat);
    expect(JSON.parse(storage.getItem("agent-desktop-ui-prefs") ?? "{}").state.computerPaneSize).toBe(800);
  });

  it("resizes immediately from the clamped edge with both keyboard and pointer", async () => {
    useUiStore.setState({ computerPaneSize: 800 });
    const divider = await mount();
    await waitFor(() => expect(tracks().computer).toBe(589));
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(tracks().computer).toBe(581);
    expect(useUiStore.getState().computerPaneSize).toBe(581);
    act(() => useUiStore.setState({ computerPaneSize: 800 }));
    Object.defineProperty(divider, "setPointerCapture", { configurable: true, value: () => {} });
    const down = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(down, { button: { value: 0 }, clientX: { value: 100 }, pointerId: { value: 1 } });
    fireEvent(divider, down);
    const move = new Event("pointermove", { bubbles: true });
    Object.defineProperty(move, "clientX", { value: 116 });
    fireEvent(divider, move);
    expect(tracks().computer).toBe(573);
    expect(useUiStore.getState().computerPaneSize).toBe(573);
    fireEvent.pointerUp(divider);
  });

  it("reserves the chat floor through sidebar expansion and physically narrow windows", async () => {
    useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 400 });
    await mount();
    await waitFor(() => expect(tracks().computer).toBe(589));
    act(() => useUiStore.getState().toggleSidebar());
    await waitFor(() => expect(tracks().sidebar).toBe(400));
    expect(tracks().computer).toBe(273);
    expect(useUiStore.getState().computerPaneSize).toBe(860);
    act(() => resize(512));
    expect(tracks().sidebar).toBe(232);
    expect(tracks().computer).toBe(0);
    expect(tracks().sidebar + tracks().computer + 280).toBe(512);
    act(() => resize(1440));
    expect(tracks()).toEqual({ sidebar: 400, computer: 760 });
  });

  it("uses the measured shell width via ResizeObserver and preserves the native 96px rail", async () => {
    const divider = await mount(true);
    await waitFor(() => expect(tracks().computer).toBe(577));
    expect(tracks().sidebar).toBe(96);
    expect(divider.getAttribute("aria-valuemax")).toBe("577");
    const computer = document.querySelector("#computer");
    const shell = document.querySelector("#shell")?.parentElement;
    if (!(shell instanceof HTMLElement) || !(computer instanceof HTMLElement)) throw new Error("missing shell panels");
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
    act(() => observedResize?.());
    expect(tracks().computer).toBe(424);
    expect(useUiStore.getState().computerPaneSize).toBe(860);
    vi.spyOn(computer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 422, 600));
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(tracks().computer).toBe(420);
  });
});
