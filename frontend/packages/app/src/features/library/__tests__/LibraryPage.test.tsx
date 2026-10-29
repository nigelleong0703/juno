import type { ApiClient, FileDownload, LibraryItem } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { createWebPlatform } from "../../../platform";
import { LibraryPage } from "../LibraryPage";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stamp = "2026-10-07T00:00:00Z";

function make(id: string, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    name: `${id}.md`,
    kind: "document",
    mimeType: "text/markdown",
    sizeBytes: 10,
    shared: "private",
    source: "agent",
    tags: [],
    createdAt: stamp,
    updatedAt: stamp,
    pinned: false,
    ...patch,
  };
}

/** The Library at `entry`, under the real `/library/:fileId?` route, with a probe for the current path. */
function renderLibrary(client: ApiClient, entry: string): void {
  function Path() {
    return <span data-testid="library-path">{useLocation().pathname}</span>;
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}>
      {children}
    </ClientProvider>
  );
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/library/:fileId?" element={<LibraryPage />} />
      </Routes>
      <Path />
    </MemoryRouter>,
    { wrapper },
  );
}

function withItems(base: ApiClient, items: LibraryItem[]): ApiClient {
  return { ...base, library: { ...base.library, list: async () => ({ items, nextCursor: null }) } };
}

describe("Library grid", () => {
  it("shows agent-made items as cells and leaves uploads out", async () => {
    const items = [make("doc-one"), make("upload-one", { source: "upload" })];
    renderLibrary(withItems(createMockClient({ seed: 1 }), items), "/library");
    expect(await screen.findByRole("button", { name: "doc-one.md" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "upload-one.md" })).toBeNull();
  });

  it("filters by category: Pages shows interactive pages only, Spaces shows apps with their status", async () => {
    const base = createMockClient({ seed: 1 });
    const items = [
      make("doc-one"),
      make("page-one", { name: "dashboard.html", render: "html", mimeType: "text/html" }),
      make("app-one", { name: "Recipe box", render: "app", spaceId: "sp-recipes" }),
    ];
    const client: ApiClient = {
      ...withItems(base, items),
      spaces: {
        ...base.spaces,
        list: async () => ({
          items: [
            { id: "sp-recipes", title: "Recipe box", slug: "recipes", agentId: "agent-juno", artifactId: "app-one", status: "computer_paused", createdAt: stamp, updatedAt: stamp },
          ],
          nextCursor: null,
        }),
      },
    };
    renderLibrary(client, "/library");
    fireEvent.click(await screen.findByRole("radio", { name: "Pages" }));
    expect(screen.getByRole("button", { name: "dashboard.html" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "doc-one.md" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Spaces" }));
    const cell = screen.getByRole("button", { name: "Recipe box" });
    expect(within(cell).getByText(/Paused/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "dashboard.html" })).toBeNull();
  });

  it("shows an empty Shared category when no Space has a hosted link", async () => {
    renderLibrary(withItems(createMockClient({ seed: 1 }), [make("doc-one")]), "/library");
    fireEvent.click(await screen.findByRole("radio", { name: "Shared" }));
    expect(await screen.findByText("No matching items")).toBeDefined();
  });
});

describe("full-screen viewer", () => {
  it("opens a tapped cell straight into the viewer, and closing it returns to the grid", async () => {
    renderLibrary(withItems(createMockClient({ seed: 1 }), [make("doc-one")]), "/library");
    fireEvent.click(await screen.findByRole("button", { name: "doc-one.md" }));
    const viewer = await screen.findByRole("dialog", { name: "doc-one.md" });
    expect(within(viewer).getByRole("button", { name: "Download" })).toBeDefined();
    expect(screen.getByTestId("library-path").textContent).toBe("/library/doc-one");
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "doc-one.md" })).toBeNull());
    expect(screen.getByRole("button", { name: "doc-one.md" })).toBeDefined();
  });

  it("shows a published page full size in the script-only sandbox on a deep link", async () => {
    renderLibrary(createMockClient({ seed: 1 }), "/library/lib-art-trip");
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe");
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("opens a paused Space through a fresh link in a tab with no opener", async () => {
    const base = createMockClient({ seed: 1 });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const client: ApiClient = {
      ...withItems(base, [make("app-one", { name: "Recipe box", render: "app", spaceId: "sp-recipes" })]),
      spaces: {
        ...base.spaces,
        get: async (id: string) => ({ id, title: "Recipe box", slug: "recipes", agentId: "agent-juno", artifactId: "app-one", status: "computer_paused", createdAt: stamp, updatedAt: stamp }),
        openUrl: async () => ({ url: "https://apps.example.test/open", expiresAt: stamp }),
      },
    };
    renderLibrary(client, "/library/app-one");
    const viewer = await screen.findByRole("dialog", { name: "Recipe box" });
    fireEvent.click(await within(viewer).findByRole("button", { name: "Wake & open" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://apps.example.test/open", "_blank", "noopener,noreferrer"));
  });

  it("downloads exact bytes through an anchor with a safe basename", async () => {
    const base = createMockClient({ seed: 1 });
    const target = (await base.library.list()).items[0];
    if (!target) throw new Error("fixture library is empty");
    const bytes = [0, 255, 128, 65, 10, 13, 0, 33];
    const binary = String.fromCharCode(...bytes);
    const seen: string[] = [];
    const saved: { blob: Blob | null; fileName: string | null } = { blob: null, fileName: null };
    const client: ApiClient = {
      ...base,
      library: {
        ...base.library,
        download: async (id: string): Promise<FileDownload> => {
          seen.push(id);
          return { name: "../evil.bin", mimeType: "application/octet-stream", contentBase64: btoa(binary) };
        },
      },
    };
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob) saved.blob = blob;
      return "blob:library-test";
    };
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.fileName = this.download;
    });
    try {
      renderLibrary(client, `/library/${target.id}`);
      const viewer = await screen.findByRole("dialog");
      fireEvent.click(await within(viewer).findByRole("button", { name: "Download" }));
      await waitFor(() => expect(seen).toContain(target.id));
      await waitFor(() => expect(saved.blob).not.toBeNull());
      if (!saved.blob) throw new Error("download blob was not saved");
      expect(new Uint8Array(await saved.blob.arrayBuffer())).toEqual(new Uint8Array(bytes));
      expect(saved.fileName).toBe("evil.bin");
    } finally {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });
});

describe("LibraryPage chat scope", () => {
  it("lists only the scoped conversation files, never other chats", async () => {
    const base = createMockClient({ seed: 1 });
    const listed = (await base.library.list()).items;
    const inScope = listed.filter((item) => item.conversationId === "conv-juno");
    if (inScope.length === 0) throw new Error("fixture needs scoped files");
    const outsider = listed.find((item) => item.conversationId && item.conversationId !== "conv-juno");
    if (!outsider) throw new Error("fixture needs another conversation file");
    renderLibrary(base, `/library?conversationId=conv-juno`);
    for (const item of inScope) expect(await screen.findByText(item.name)).toBeDefined();
    expect(screen.queryByText(outsider.name)).toBeNull();
    expect(screen.queryByText("Select a chat to see its files")).toBeNull();
  });

  it("shows Chat files chrome with a Back to chat button on a scoped page", async () => {
    renderLibrary(createMockClient({ seed: 1 }), `/library?conversationId=conv-juno`);
    expect(await screen.findByText("Chat files")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeDefined();
  });

  it("says No files in this chat for a scoped chat without files", async () => {
    const base = createMockClient({ seed: 1 });
    const client: ApiClient = { ...base, library: { ...base.library, list: async () => ({ items: [], nextCursor: null }) } };
    renderLibrary(client, `/library?conversationId=conv-quiet`);
    expect(await screen.findByText("No files in this chat")).toBeDefined();
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeDefined();
  });
});
