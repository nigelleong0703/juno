/**
 * PH11 budget UI: the global settings Budget section renders the owner-wide limits from
 * settings.usage and saves them through settings.update (never a per-agent model option).
 */
import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBudget(client: ApiClient): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider>
      <ClientProvider client={client} queryClient={queryClient} platform={webPlatform}>
        <MemoryRouter initialEntries={["/settings/budget"]}>
          <Routes>
            <Route path="/settings/:section" element={children} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </ThemeProvider>
  );
  render(<AppSettingsPage />, { wrapper });
}

describe("settings budget section", () => {
  it("shows the configured limits and saves an updated owner-wide budget", async () => {
    const client = createMockClient({ seed: 1 });
    const base = await client.settings.get();
    vi.spyOn(client.settings, "get").mockResolvedValue({ ...base, usage: { steps: 5, onUnknown: "ignore" } });
    const update = vi.spyOn(client.settings, "update").mockResolvedValue(base);
    renderBudget(client);

    const steps = (await screen.findByText("Max steps")).querySelector("input");
    expect(steps?.value).toBe("5");
    fireEvent.change(steps ?? document.createElement("input"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toEqual({ usage: { steps: 7, onUnknown: "ignore" } });
  });

  it("defaults to the actual block policy and clears a blanked budget", async () => {
    const client = createMockClient({ seed: 1 });
    const base = await client.settings.get();
    vi.spyOn(client.settings, "get").mockResolvedValue({ ...base, usage: { steps: 5 } });
    const update = vi.spyOn(client.settings, "update").mockResolvedValue(base);
    renderBudget(client);

    const steps = (await screen.findByText("Max steps")).querySelector("input");
    expect(steps?.value).toBe("5");
    fireEvent.change(steps ?? document.createElement("input"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // Blank steps are omitted and the policy mirrors the real default (block), so the constraint clears.
    expect(update.mock.calls[0]?.[0]).toEqual({ usage: { onUnknown: "block" } });
  });
});
