import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { PermissionsTab } from "../card/PermissionsTab";

afterEach(cleanup);

async function renderTab(client: ApiClient) {
  const agent = await client.agents.get("agent-juno");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="light">
      <TooltipProvider>
        <AuthContext.Provider value={{ mode: "account", user: { id: "member-robin", name: "Robin", email: "n@example.com", initials: "N" }, signOut: () => {} }}>
          <ClientProvider client={client} queryClient={queryClient}>
            <MemoryRouter>
              <PermissionsTab agent={{ ...agent, createdBy: undefined }} />
            </MemoryRouter>
          </ClientProvider>
        </AuthContext.Provider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("permissions: what the agent can decide alone", () => {
  it("lists each kind as Ask me or its rules with limits, edits and revokes a rule, and always asks the rest", async () => {
    const base = createMockClient({ seed: 3 });
    const update = vi.fn(base.delegations.update);
    const revoke = vi.fn(base.delegations.revoke);
    await renderTab({ ...base, delegations: { ...base.delegations, update, revoke } });

    expect(await screen.findByText("Replies only, up to 10/day on Gmail")).toBeDefined();
    expect(screen.getAllByText("Ask me")).toHaveLength(4);
    expect(screen.getAllByText("Always asks")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Edit limits" }));
    fireEvent.change(await screen.findByLabelText("Most per day"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("rule-delegation-speaking", { limits: { replyOnly: true, maxPerDay: 20 } }));

    fireEvent.click(await screen.findByRole("button", { name: "Edit limits" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("rule-delegation-speaking"));
    await waitFor(() => expect(screen.getAllByText("Ask me")).toHaveLength(5));
  });

  it("lists sharing between chats as the files it moves and when it ends, with nothing to edit but revoking it", async () => {
    const base = createMockClient({ seed: 3 });
    await base.delegations.create({ agentId: "agent-juno", category: "sharing", platform: { kind: "chat", conversationId: "conv-launch", title: "work" }, limits: { recipients: ["conv-offsite", "conv-gone"] } });
    const revoke = vi.fn(base.delegations.revoke);
    await renderTab({ ...base, delegations: { ...base.delegations, revoke } });

    // The rule keeps only the chat's id, so the source and the targets are named from the chat list; an unknown chat is "a chat".
    expect(await screen.findByText(/^Files from #Launch prep → #Offsite crew, a chat · expires /u)).toBeDefined();
    expect(screen.getAllByText("Ask me")).toHaveLength(3);

    const rows = screen.getAllByRole("button", { name: "Edit limits" });
    fireEvent.click(rows[rows.length - 1] as HTMLElement);
    expect(await screen.findByText("Share between chats rule")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Save limits" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
  });

  it("shows the first three rules of a kind and the rest on request", async () => {
    const base = createMockClient({ seed: 3 });
    for (const conversationId of ["conv-launch", "conv-offsite", "conv-patch", "conv-atlas"]) {
      await base.delegations.create({ agentId: "agent-juno", category: "sharing", platform: { kind: "chat", conversationId }, limits: { recipients: ["conv-juno"] } });
    }
    await renderTab(base);
    const shown = async () => (await screen.findAllByText(/^Files from /u)).length;
    expect(await shown()).toBe(3);
    fireEvent.click(await screen.findByRole("button", { name: "Show all 4" }));
    await waitFor(async () => expect(await shown()).toBe(4));
    expect(screen.getByRole("button", { name: "Show less" })).toBeDefined();
  });

  it("folds consecutive rule-allowed decisions into one group", async () => {
    await renderTab(createMockClient({ seed: 3 }));
    const group = await screen.findByRole("button", { name: "2 allowed by your rules" });
    expect(screen.queryByText("Reply to Mei with the meeting notes")).toBeNull();
    fireEvent.click(group);
    expect(await screen.findByText("Reply to Mei with the meeting notes")).toBeDefined();
    // The other decisions stand alone, with the outcome in words.
    expect(screen.getByText(/\$30\.00 · Allowed once/u)).toBeDefined();
  });
});
