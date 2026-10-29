import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { ClientProvider } from "../../data/ClientProvider";
import { t } from "../../lib/i18n";
import { webPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { AppShell } from "../AppShell";

// jsdom lacks ResizeObserver, which the shell's PanelGroup constructs on mount.
beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

// Node 26 leaves `window.localStorage` unavailable under jsdom, which breaks the persisted UI
// store the moment a test changes it. Point persist at an in-memory store instead.
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

let mounts = 0;

/** Stands in for the conversation column; its mount count exposes any remount of the subtree. */
function ConversationSentinel() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="conversation-sentinel">conversation</div>;
}

function renderShell() {
  const client = createMockClient({ seed: 5 });
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} events={client} platform={webPlatform}>
          <MemoryRouter initialEntries={["/c/conv-juno"]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="c/:conversationId" element={<ConversationSentinel />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("AppShell computer pane", () => {
  it("keeps the conversation subtree mounted across open and close", async () => {
    useUiStore.setState({ computerPanelOpen: false });
    mounts = 0;
    renderShell();

    const sentinel = screen.getByTestId("conversation-sentinel");
    expect(mounts).toBe(1);

    await act(async () => {
      useUiStore.setState({ computerPanelOpen: true });
    });
    expect(screen.getByTestId("conversation-sentinel")).toBe(sentinel);

    await act(async () => {
      useUiStore.setState({ computerPanelOpen: false });
    });
    expect(screen.getByTestId("conversation-sentinel")).toBe(sentinel);
    expect(mounts).toBe(1);
  });
});

describe("AppShell computer rail", () => {
  it("folds the chat list to its rail while the computer is open without saving that preference", async () => {
    useUiStore.setState({ sidebarCollapsed: false, computerPanelOpen: true });
    renderShell();

    // The rail is avatars only: the search field stays mounted and hides in
    // place behind inert + aria-hidden (still reachable from ⌘K) while the
    // grid folds to the rail.
    const search = screen.getByPlaceholderText(t("sidebar.searchPlaceholder"));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sidebar-inner"]')?.getAttribute("data-collapsed")).toBe(
        "true",
      ),
    );
    expect(search.closest("[inert]")).not.toBeNull();
    expect(search.closest("[inert]")?.getAttribute("aria-hidden")).toBe("true");
    const shell = document.querySelector("#shell");
    if (!(shell instanceof HTMLElement)) throw new Error("shell not found");
    expect(shell.style.gridTemplateColumns.startsWith("84px")).toBe(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);

    await act(async () => {
      useUiStore.setState({ computerPanelOpen: false });
    });

    // Closing the pane restores the manual list, and the saved preference was never rewritten.
    await waitFor(() => expect(search.closest("[inert]")).toBeNull());
    expect(
      document.querySelector('[data-slot="sidebar-inner"]')?.getAttribute("data-collapsed"),
    ).toBeNull();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it("lets a manual toggle expand the list while the computer's rail is showing", async () => {
    useUiStore.setState({ sidebarCollapsed: false, computerPanelOpen: true });
    renderShell();
    const search = screen.getByPlaceholderText(t("sidebar.searchPlaceholder"));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sidebar-inner"]')?.getAttribute("data-collapsed")).toBe(
        "true",
      ),
    );

    await act(async () => {
      useUiStore.getState().toggleSidebar();
    });

    // A manual toggle while the temporary rail shows means "show the list":
    // the override drops and the search is reachable again.
    await waitFor(() => expect(search.closest("[inert]")).toBeNull());
    expect(
      document.querySelector('[data-slot="sidebar-inner"]')?.getAttribute("data-collapsed"),
    ).toBeNull();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});
