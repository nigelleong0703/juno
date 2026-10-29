import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { createWebPlatform } from "../../../platform";
import { MemoryRouter, Route, Routes } from "react-router";
import { LibraryPage } from "../../../features/library/LibraryPage";

// The dialog's Radix switch measures itself; jsdom has no ResizeObserver.
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The Space's full-screen viewer, where its Share sheet lives. */
function renderViewer(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/library/lib-app-budget"]}>
      <Routes>
        <Route path="/library/:fileId?" element={<LibraryPage />} />
      </Routes>
    </MemoryRouter>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}>{children}</ClientProvider>
      ),
    },
  );
}

/** An error shaped like the HTTP transport's: a status and the server's error code. */
function httpError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Opens the viewer's Share sheet once the app has loaded. */
async function openShare() {
  const viewer = await screen.findByRole("dialog", { name: "Budget tracker" });
  await within(viewer).findByText("Running");
  fireEvent.click(within(viewer).getByRole("button", { name: "Share" }));
  return screen.findByRole("dialog", { name: /^Share/ });
}

describe("hosted Space sharing sheet", () => {
  it("publishes a link for an unshared app, then shows the link and its access", async () => {
    const client = createMockClient({ seed: 1 });
    const publishHosted = vi.fn(client.spaces.publishHosted);
    renderViewer({ ...client, spaces: { ...client.spaces, publishHosted } });
    const dialog = await openShare();

    fireEvent.click(within(dialog).getByRole("button", { name: "Share link" }));

    await waitFor(() => expect(publishHosted).toHaveBeenCalledWith("sp-budget", {}));
    expect(await within(dialog).findByRole("radio", { name: "Link" })).toBeDefined();
    expect(within(dialog).getByText("https://sp-budget-mock.spaces.example.test/")).toBeDefined();
    expect((within(dialog).getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
  });

  it("changes visibility and lets visitors write, one change per control", async () => {
    const client = createMockClient({ seed: 1 });
    const shared = await client.spaces.publishHosted("sp-budget", {});
    expect(shared.visitorWrites).toBe(false);
    const updateHosted = vi.fn(client.spaces.updateHosted);
    renderViewer({ ...client, spaces: { ...client.spaces, updateHosted } });
    const dialog = await openShare();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Public" }));
    await waitFor(() => expect(updateHosted).toHaveBeenLastCalledWith("sp-budget", { visibility: "public" }));

    fireEvent.click(within(dialog).getByRole("switch"));
    await waitFor(() => expect(updateHosted).toHaveBeenLastCalledWith("sp-budget", { visitorWrites: true }));
    await waitFor(() => expect((within(dialog).getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true"));
    expect(updateHosted).toHaveBeenCalledTimes(2);
  });

  it("opens the hosted copy as the owner in a new tab", async () => {
    const client = createMockClient({ seed: 1 });
    await client.spaces.publishHosted("sp-budget", {});
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderViewer(client);
    const dialog = await openShare();

    fireEvent.click(within(dialog).getByRole("button", { name: "Open as me" }));

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]?.[0]).toContain("/__auth?t=");
  });

  it("asks before stopping sharing, then returns to the unshared state", async () => {
    const client = createMockClient({ seed: 1 });
    await client.spaces.publishHosted("sp-budget", {});
    const revokeHosted = vi.fn(client.spaces.revokeHosted);
    renderViewer({ ...client, spaces: { ...client.spaces, revokeHosted } });
    const dialog = await openShare();

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(revokeHosted).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Stop sharing" }));

    await waitFor(() => expect(revokeHosted).toHaveBeenCalledWith("sp-budget"));
    expect(await within(dialog).findByRole("button", { name: "Share link" })).toBeDefined();
    expect(within(dialog).queryByRole("radio", { name: "Link" })).toBeNull();
  });

  it("says sharing is not set up on a server without hosting", async () => {
    const client = createMockClient({ seed: 1 });
    const publishHosted = vi.fn(() => Promise.reject(httpError(503, "HOSTED_UNAVAILABLE", "hosting not configured")));
    renderViewer({ ...client, spaces: { ...client.spaces, publishHosted } });
    const dialog = await openShare();

    fireEvent.click(within(dialog).getByRole("button", { name: "Share link" }));

    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Sharing links aren't set up on this server yet");
  });

  it("shows the server's reason when the app runs its own server code", async () => {
    const client = createMockClient({ seed: 1 });
    const reason = "This Space runs its own server code; it can only be shared from your computer (option A)";
    const publishHosted = vi.fn(() => Promise.reject(httpError(409, "SPACE_HAS_SERVER_CODE", reason)));
    renderViewer({ ...client, spaces: { ...client.spaces, publishHosted } });
    const dialog = await openShare();

    fireEvent.click(within(dialog).getByRole("button", { name: "Share link" }));

    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", reason);
  });
});
