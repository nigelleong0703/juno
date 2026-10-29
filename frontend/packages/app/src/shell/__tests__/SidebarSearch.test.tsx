import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../data/ClientProvider";
import { webPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { Sidebar } from "../Sidebar";

afterEach(cleanup);

function RouteProbe({ onPath }: { onPath: (path: string) => void }) {
  const location = useLocation();
  onPath(`${location.pathname}${location.search}${location.hash}`);
  return null;
}

function mountSidebar(initialPath = "/c/conv-juno") {
  const client = createMockClient({ seed: 5 });
  useUiStore.setState({ sidebarCollapsed: false, sidebarSize: 280 });
  let path = initialPath;
  const view = render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} platform={webPlatform}>
          <MemoryRouter initialEntries={[initialPath]}>
            <RouteProbe onPath={(next) => { path = next; }} />
            <Sidebar />
          </MemoryRouter>
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { view, pathOf: () => path };
}

async function selectedRow(view: { container: HTMLElement }) {
  return waitFor(() => {
    const row = view.container.querySelector('[data-slot="sidebar-list"] [aria-current="page"]');
    expect(row).not.toBeNull();
    return row as HTMLElement;
  });
}

describe("sidebar search keeps selection by conversation id", () => {
  it("keeps the active row on a matching query without leaving the route", async () => {
    const { view, pathOf } = mountSidebar();
    const first = await selectedRow(view);
    expect(first.textContent).toContain("Juno");
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "Juno" } });
    const kept = await waitFor(() => {
      const row = view.container.querySelector('[data-slot="sidebar-list"] [aria-current="page"]');
      expect(row?.textContent).toContain("Juno");
      return row;
    });
    expect(kept).not.toBeNull();
    expect(pathOf()).toBe("/c/conv-juno");
  });

  it("hides the active marker when the query excludes it without leaving the route", async () => {
    const { view, pathOf } = mountSidebar();
    await selectedRow(view);
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "Patch" } });
    await waitFor(() => expect(view.container.querySelector('[data-slot="sidebar-list"] [aria-current="page"]')).toBeNull());
    expect(view.container.textContent).toContain("Patch");
    expect(view.container.textContent).not.toContain("Juno");
    expect(pathOf()).toBe("/c/conv-juno");
  });

  it("shows the empty state on no results without leaving the route", async () => {
    const { view, pathOf } = mountSidebar();
    await selectedRow(view);
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "zzz-no-such-chat" } });
    await waitFor(() => expect(view.container.querySelector('[data-slot="sidebar-list"] [aria-current="page"]')).toBeNull());
    expect(view.container.querySelector('[data-slot="sidebar-list"] ul')).toBeNull();
    expect(pathOf()).toBe("/c/conv-juno");
  });

  it("restores the active row when the query is cleared", async () => {
    const { view, pathOf } = mountSidebar();
    await selectedRow(view);
    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "Patch" } });
    await waitFor(() => expect(view.container.querySelector('[data-slot="sidebar-list"] [aria-current="page"]')).toBeNull());
    fireEvent.change(input, { target: { value: "" } });
    const restored = await selectedRow(view);
    expect(restored.textContent).toContain("Juno");
    expect(pathOf()).toBe("/c/conv-juno");
  });

});
