import type { MacAppAccess } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { MyMacApps } from "../MyMacApps";

afterEach(cleanup);

const app = (n: number, patch: Partial<MacAppAccess> = {}): MacAppAccess => ({ app: `com.example.app${n}`, name: `App ${n}`, allowedAt: "2026-10-01T09:00:00.000Z", ...patch });

function appsClient(initial: MacAppAccess[]) {
  let apps = initial;
  const revoked: string[] = [];
  const base = createMockClient({ seed: 402 });
  const client: MockClient = {
    ...base,
    macApps: async () => ({ apps }),
    revokeMacApp: async (key) => {
      revoked.push(key);
      apps = apps.filter((entry) => entry.app !== key);
      return { apps };
    },
  };
  return { client, revoked };
}

function renderApps(client: MockClient) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
          <MyMacApps />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("Apps agents may use", () => {
  it("says so when nothing is allowed yet", async () => {
    renderApps(appsClient([]).client);
    await screen.findByText(/Agents ask the first time/u);
  });

  it("lists the apps with last use, caps the list, and removes one only after a confirm", async () => {
    const { client, revoked } = appsClient([app(1, { lastUsedAt: new Date().toISOString() }), ...[2, 3, 4, 5, 6, 7].map((n) => app(n))]);
    renderApps(client);
    await screen.findByText("App 1");
    expect(screen.getByText(/last used now/u)).toBeDefined();
    expect(screen.queryByText("App 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show more/u }));
    expect(screen.getByText("App 7")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0] as HTMLElement);
    expect(revoked).toEqual([]);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(revoked).toEqual(["com.example.app1"]));
    await waitFor(() => expect(screen.queryByText("App 1")).toBeNull());
  });
});
