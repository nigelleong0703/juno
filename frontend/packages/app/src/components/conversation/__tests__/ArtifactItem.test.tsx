import type { ApiClient, Item, LibraryItem } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { LibraryPage } from "../../../features/library/LibraryPage";
import { createWebPlatform } from "../../../platform";
import { ArtifactItem } from "../ArtifactItem";
import { decodePreview, previewKind } from "../artifactPreview";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function artifactItem(artifactId: string): Extract<Item, { type: "artifact" }> {
  return {
    id: "itm-artifact-1",
    conversationId: "conv-juno",
    at: "2026-10-06T00:00:00.000Z",
    type: "artifact",
    artifactId,
  };
}

/** A chat transcript with one artifact card, and the Library's viewer route it opens. */
function renderCard(client: ApiClient, artifactId = "lib-sandbox-md"): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Path() {
    return <span data-testid="route-path">{useLocation().pathname}</span>;
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}>
      {children}
    </ClientProvider>
  );
  render(
    <MemoryRouter initialEntries={["/c/conv-juno"]}>
      <Routes>
        <Route path="/c/:conversationId" element={<ArtifactItem item={artifactItem(artifactId)} />} />
        <Route path="/library/:fileId?" element={<LibraryPage />} />
      </Routes>
      <Path />
    </MemoryRouter>,
    { wrapper },
  );
  return queryClient;
}

describe("ArtifactItem", () => {
  it("opens a tapped card in the full-screen viewer, showing its real UTF-8 text", async () => {
    const base = createMockClient({ seed: 1 });
    const text = "# 新加坡到吉隆坡机票\n\nAirAsia S$137\n完整内容在这里";
    const client: ApiClient = {
      ...base,
      library: {
        ...base.library,
        download: async () => ({ name: "sandbox-comparison.md", mimeType: "text/markdown", contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode(text))) }),
      },
    };
    renderCard(client);
    fireEvent.click(await screen.findByRole("button", { name: "sandbox-comparison.md" }));
    const viewer = await screen.findByRole("dialog", { name: "sandbox-comparison.md" });
    await waitFor(() => expect(viewer.textContent).toContain("完整内容在这里"));
    expect(screen.getByTestId("route-path").textContent).toBe("/library/lib-sandbox-md");
  });

  it("rejects executable image MIME and oversized returned bytes", async () => {
    const item = await createMockClient({ seed: 1 }).library.get("lib-sandbox-md");
    expect(previewKind({ ...item, mimeType: "image/svg+xml" })).toBeNull();
    expect(previewKind({ ...item, mimeType: "text/html" })).toBeNull();
    expect(() => decodePreview(item, { name: item.name, mimeType: "text/html", contentBase64: btoa("<script>bad</script>") })).toThrow();
    expect(() => decodePreview(item, { name: item.name, mimeType: "text/markdown", contentBase64: btoa("x".repeat(256 * 1024 + 1)) })).toThrow();
  });

  it("decodes raster bytes without relying on remote preview URLs", async () => {
    const item = await createMockClient({ seed: 1 }).library.get("lib-sandbox-md");
    const preview = decodePreview({ ...item, name: "image.png", mimeType: "image/png", sizeBytes: 3 }, { name: "image.png", mimeType: "image/png", contentBase64: btoa("abc") });
    expect(preview.kind).toBe("image");
    if (preview.kind !== "image") throw new Error("Expected image");
    expect(preview.blob.type).toBe("image/png");
    expect(preview.blob.size).toBe(3);
  });

  it("shows a loading card while the entry resolves", () => {
    const base = createMockClient({ seed: 1 });
    const client: ApiClient = {
      ...base,
      library: {
        ...base.library,
        get: () => new Promise<LibraryItem>(() => {}),
      },
    };
    renderCard(client);
    expect(screen.getByText("Loading file…")).toBeDefined();
  });

  it("shows an error card with retry instead of disappearing", async () => {
    const base = createMockClient({ seed: 1 });
    let calls = 0;
    const client: ApiClient = {
      ...base,
      library: {
        ...base.library,
        get: async (id: string) => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error("gone"), { status: 404, code: "NOT_FOUND" });
          return base.library.get(id);
        },
      },
    };
    renderCard(client);
    await waitFor(() => expect(screen.getByText("File unavailable")).toBeDefined());
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByRole("button", { name: "sandbox-comparison.md" })).toBeDefined());
  });

  it("renders the card as a thumbnail cell with the name and the agent's line", async () => {
    const base = createMockClient({ seed: 1 });
    renderCard(base);
    const cell = await screen.findByRole("button", { name: "sandbox-comparison.md" });
    expect(within(cell).getByText("sandbox-comparison.md")).toBeDefined();
    expect(cell.querySelector("[data-slot=artifact-thumb]")).not.toBeNull();
  });

  it("keeps a visible card for entries that no longer exist", async () => {
    const base = createMockClient({ seed: 1 });
    const client: ApiClient = {
      ...base,
      library: {
        ...base.library,
        get: async () => {
          throw Object.assign(new Error("missing"), { status: 404, code: "NOT_FOUND" });
        },
      },
    };
    const { container } = render(
      <MemoryRouter>
        <ArtifactItem item={artifactItem("lib-ghost")} />
      </MemoryRouter>,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ClientProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} platform={createWebPlatform()}>
            {children}
          </ClientProvider>
        ),
      },
    );
    await waitFor(() => expect(screen.getByText("File unavailable")).toBeDefined());
    expect(container.textContent).not.toBe("");
  });

  it("invalidates library and artifact queries when a file lands over SSE", () => {
    const qc = new QueryClient();
    qc.setQueryData(["library", {}], []);
    qc.setQueryData(["artifact", "lib-sandbox-md"], null);
    applyEvent(qc, { type: "item.added", conversationId: "conv-juno", item: artifactItem("lib-sandbox-md") });
    expect(qc.getQueryState(["library", {}])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["artifact", "lib-sandbox-md"])?.isInvalidated).toBe(true);
  });

  it("leaves library queries alone for non-file items", () => {
    const qc = new QueryClient();
    qc.setQueryData(["library", {}], []);
    applyEvent(qc, {
      type: "item.added",
      conversationId: "conv-juno",
      item: {
        id: "itm-sys-1",
        conversationId: "conv-juno",
        at: "2026-10-06T00:00:00.000Z",
        type: "system",
        level: "info",
        text: "hello",
      },
    });
    expect(qc.getQueryState(["library", {}])?.isInvalidated).not.toBe(true);
  });
});
