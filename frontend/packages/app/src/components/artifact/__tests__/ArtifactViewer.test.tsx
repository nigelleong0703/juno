import type { ApiClient, LibraryItem } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { LibraryPage } from "../../../features/library/LibraryPage";
import { createWebPlatform } from "../../../platform";

beforeEach(() => {
  // jsdom has no object URLs; the viewer only needs a string for src.
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The viewer at `/library/:id`, rendered over the Library the way the app mounts it. */
function renderViewer(client: ApiClient, id: string): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}>
      <MemoryRouter initialEntries={[`/library/${id}`]}>
        <Routes>
          <Route path="/library/:fileId?" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  );
  return queryClient;
}

describe("artifact viewer", () => {
  it("asks for a new render address when the cached one is about to expire", async () => {
    const base = createMockClient({ seed: 1 });
    const renderUrl = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://usercontent.test/a/old", expiresAt: new Date(Date.now() + 5_000).toISOString() })
      .mockResolvedValue({ url: "https://usercontent.test/a/new", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    renderViewer({ ...base, artifacts: { ...base.artifacts, renderUrl } }, "lib-art-trip");
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBe("https://usercontent.test/a/new"));
    expect(renderUrl).toHaveBeenCalledTimes(2);
  });

  it("switches versions from the top bar, and follows a new version that arrives live", async () => {
    const base = createMockClient({ seed: 1 });
    const renderUrl = vi.fn(base.artifacts.renderUrl);
    let served: LibraryItem = await base.library.get("lib-art-trip");
    const client: ApiClient = {
      ...base,
      library: {
        ...base.library,
        get: async () => served,
        list: async () => ({ items: [served], nextCursor: null }),
      },
      artifacts: { ...base.artifacts, renderUrl },
    };
    const queryClient = renderViewer(client, "lib-art-trip");
    const picker = await screen.findByRole("button", { name: "Choose version" });
    expect(picker.textContent).toContain("v2");
    expect(picker.textContent).toContain("updated");
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "v1" }));
    await waitFor(() => expect(renderUrl).toHaveBeenCalledWith("lib-art-trip", 1));
    expect(screen.getByRole("button", { name: "Choose version" }).textContent).toContain("v1");

    const current = await base.library.get("lib-art-trip");
    const v2 = current.versions![1]!;
    served = { ...current, version: 3, versions: [...current.versions!, { ...v2, version: 3, fileRef: "af-3" }] };
    applyEvent(queryClient, { type: "artifact.updated", artifact: served });
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Choose version" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "v3 (latest)" })).toBeDefined();
  });

  it("shows an office file's first-page picture in its cell and its PDF preview in the viewer", async () => {
    const base = createMockClient({ seed: 1 });
    const download = vi.fn(base.artifacts.download);
    renderViewer({ ...base, artifacts: { ...base.artifacts, download } }, "lib-art-report");
    await waitFor(() => expect(download).toHaveBeenCalledWith("lib-art-report", 1, "thumbnail"));
    await waitFor(() => expect(download).toHaveBeenCalledWith("lib-art-report", 1, "preview"));
  });

  it("shows Markdown in the viewer as text", async () => {
    renderViewer(createMockClient({ seed: 1 }), "lib-art-readme");
    const viewer = await screen.findByRole("dialog", { name: "launch-checklist.md" });
    expect(await within(viewer).findByText("Launch checklist")).toBeDefined();
  });

  it("shows an image full size, with zoom steps", async () => {
    renderViewer(createMockClient({ seed: 1 }), "lib-art-poster");
    const viewer = await screen.findByRole("dialog", { name: "launch-poster.png" });
    await waitFor(() => expect(within(viewer).getByAltText("launch-poster.png")).toBeDefined());
    expect(within(viewer).getByText("100%")).toBeDefined();
    fireEvent.click(within(viewer).getByRole("button", { name: "Zoom in" }));
    expect(within(viewer).getByText("150%")).toBeDefined();
  });
});
