import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { AppSettingsPage } from "../AppSettingsPage";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(client: ReturnType<typeof createMockClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="dark">
      <ClientProvider client={client} queryClient={queryClient} platform={webPlatform}>
        <MemoryRouter initialEntries={["/settings/details"]}>
          <Routes>
            <Route path="/settings/:section?" element={<AppSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </ThemeProvider>,
  );
}

describe("Your details", () => {
  it("starts with the empty state, adds a detail, and saves the whole list", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    const put = vi.spyOn(client.profile, "put");
    renderPage(client);
    expect(await screen.findByText(/Nothing yet\. Juno adds details here/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findAllByText("Required")).length).toBe(2);
    expect(put).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: "Home address" } });
    fireEvent.change(within(dialog).getByLabelText(/Value/), { target: { value: "10 Anson Rd\nSingapore 079903" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Shared" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]?.[0]).toEqual({ entries: [{ id: expect.any(String), key: "Home address", value: "10 Anson Rd\nSingapore 079903", visibility: "shared" }] });
    expect(await screen.findByText("Home address")).toBeDefined();
    expect(screen.getByText("10 Anson Rd, Singapore 079903")).toBeDefined();
    expect(screen.getByText("Added by you")).toBeDefined();
  });

  it("edits a row, shows what the agent learned, and deletes", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    await client.profile.put({ entries: [{ id: "e1", key: "Work email", value: "jane@acme.com", visibility: "private" }] });
    const put = vi.spyOn(client.profile, "put");
    renderPage(client);
    fireEvent.click(await screen.findByText("Work email"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Value/), { target: { value: "jane@acme.org" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]?.[0]).toEqual({ entries: [{ id: "e1", key: "Work email", value: "jane@acme.org", visibility: "private" }] });
    expect(await screen.findByText("jane@acme.org")).toBeDefined();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Work email" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]?.[0]).toEqual({ entries: [] });
  });

  it("caps a long list with Show more", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    await client.profile.put({ entries: Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, key: `Detail ${i}`, value: "v", visibility: "private" as const })) });
    renderPage(client);
    await screen.findByText("Detail 0");
    expect(screen.queryByText("Detail 8")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(await screen.findByText("Detail 11")).toBeDefined();
  });
});
