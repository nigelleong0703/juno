import type { ProactiveRule } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ProactiveRulesSection } from "../ProactiveRules";

afterEach(cleanup);

function rule(n: number, patch: Partial<ProactiveRule> = {}): ProactiveRule {
  return { id: `rule-${n}`, kind: "less", scope: "topic", text: `Rule ${n}`, source: `"say ${n}"`, date: "2026-10-01", dueForReview: false, ...patch };
}

/** The mock client with `rules` as the stored list; keep and delete are recorded. */
function rulesClient(initial: ProactiveRule[]) {
  let rules = initial;
  const calls: string[] = [];
  const base = createMockClient({ seed: 401 });
  const client: MockClient = {
    ...base,
    proactive: {
      ...base.proactive,
      listRules: async () => ({ items: rules }),
      keepRule: async (id) => {
        calls.push(`keep:${id}`);
        rules = rules.map((entry) => (entry.id === id ? { ...entry, dueForReview: false } : entry));
        return rules.find((entry) => entry.id === id) as ProactiveRule;
      },
      deleteRule: async (id) => {
        calls.push(`delete:${id}`);
        rules = rules.filter((entry) => entry.id !== id);
        return {};
      },
    },
  };
  return { client, calls };
}

function renderRules(client: MockClient) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
          <ProactiveRulesSection />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("Proactive rules", () => {
  it("with no rules a line explains where they come from", async () => {
    renderRules(rulesClient([]).client);
    await screen.findByText(/stop telling me about cricket/);
  });

  it("groups in reading order, skips empty groups, caps a group at five and shows the rest on request", async () => {
    const { client } = rulesClient([
      rule(1, { kind: "tell", text: "Tell me about trains" }),
      rule(2, { kind: "dont", strength: "never", text: "Not cricket" }),
      ...[3, 4, 5, 6, 7, 8, 9].map((n) => rule(n)),
    ]);
    renderRules(client);
    await screen.findByText("Not cricket");
    const titles = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(titles).toEqual(["Don't tell me", "Less of", "Tell me"]);
    expect(screen.queryByText("Rule 8")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more (2)" }));
    expect(screen.getByText("Rule 9")).toBeTruthy();
  });

  it("a rule due for review shows a badge; Keep keeps it, Remove asks first and then deletes", async () => {
    const { client, calls } = rulesClient([rule(1, { text: "Fewer news digests", dueForReview: true })]);
    renderRules(client);
    await screen.findByText("Fewer news digests");
    expect(screen.getByText("Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByText("Review")).toBeNull());
    expect(calls).toEqual(["keep:rule-1"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove: Fewer news digests" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls).toEqual(["keep:rule-1"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Fewer news digests")).toBeNull());
    expect(calls).toEqual(["keep:rule-1", "delete:rule-1"]);
  });
});
