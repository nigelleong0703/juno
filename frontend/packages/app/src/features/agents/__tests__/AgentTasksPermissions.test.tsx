import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { AgentProfile } from "../card/AgentProfile";

vi.mock("../../../components/computer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../components/computer")>()),
  ComputerPane: () => <div data-testid="computer-pane" />,
}));

afterEach(cleanup);

async function renderCard(client: ApiClient) {
  const agent = await client.agents.get("agent-juno");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="light">
      <TooltipProvider>
        <AuthContext.Provider value={{ mode: "account", user: { id: "member-robin", name: "Robin", email: "n@example.com", initials: "N" }, signOut: () => {} }}>
          <ClientProvider client={client} queryClient={queryClient}>
            <MemoryRouter>
              <AgentProfile agent={{ ...agent, createdBy: undefined }} />
            </MemoryRouter>
          </ClientProvider>
        </AuthContext.Provider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("agent profile: tasks and permissions", () => {
  it("shows the running task's progress under the avatar and stops it from its row", async () => {
    const base = createMockClient({ seed: 3 });
    const stop = vi.fn(base.tasks.stop);
    await renderCard({ ...base, tasks: { ...base.tasks, stop } });
    // The doing line is the running task's progress, and its row carries a round Stop.
    expect((await screen.findAllByText("Running the 50-boot sample on the arm64 host")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Stop Benchmark Firecracker cold starts" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith("task-juno-sub"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull());
    // The question waits one level down, under the helper that is stopped: the group is open because of it.
    expect(screen.getByText("Waiting for you · Which baseline matters more, cold or warm starts?")).toBeDefined();
  });

  it("lists standing grants with a Revoke that deletes the rule, and history as slim rows", async () => {
    const base = createMockClient({ seed: 3 });
    const agent = await base.agents.get("agent-ledger");
    const del = vi.fn(base.rules.delete);
    const client: ApiClient = { ...base, rules: { ...base.rules, delete: del }, agents: { ...base.agents, get: async () => agent } };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <AuthContext.Provider value={{ mode: "account", user: { id: "member-robin", name: "Robin", email: "n@example.com", initials: "N" }, signOut: () => {} }}>
            <ClientProvider client={client} queryClient={queryClient}>
              <MemoryRouter>
                <AgentProfile agent={{ ...agent, createdBy: undefined }} />
              </MemoryRouter>
            </ClientProvider>
          </AuthContext.Provider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Permissions" }));
    // Per-tool rules from before delegations sit read-only under "Older rules".
    fireEvent.click(await screen.findByRole("button", { name: "Older rules" }));
    expect(await screen.findByText("Allow buying from figma.com")).toBeDefined();
    // The history row names the outcome, not a tool id, and expands in place.
    const row = await screen.findByRole("button", { name: /Allowed.*Order at/u });
    fireEvent.click(row);
    expect(await screen.findByText("Saved card")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Revoke: Allow buying from figma.com" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("rule-ledger-figma"));
    await waitFor(() => expect(screen.queryByText("Allow buying from figma.com")).toBeNull());
  });
});
