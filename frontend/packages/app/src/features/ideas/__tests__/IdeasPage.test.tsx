import type { Agent, Idea, ProactiveRule } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, Toaster, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { IdeasPage } from "../IdeasPage";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(cleanup);

const ISO = "2026-10-10T08:00:00.000Z";

function idea(n: number, agentId: string): Idea {
  return { id: `idea-${n}`, agentId, text: `Offer number ${n}`, prompt: `Do offer ${n}.`, status: "open", createdAt: ISO, updatedAt: ISO };
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

/** The mock client with `ideas` as the open list; accept and dismiss take the idea off it and are recorded. */
async function ideasClient(seed: number, make: (agent: Agent) => Idea[]) {
  const base = createMockClient({ seed });
  const agent = (await base.agents.list()).items[0] as Agent;
  let open = make(agent);
  const decided: string[] = [];
  const client: MockClient = {
    ...base,
    // No starters on Today: these tests are about the agents' own ideas.
    feed: { ...base.feed, today: async () => ({ ...(await base.feed.today()), inspiration: [] }) },
    ideas: {
      ...base.ideas,
      list: async () => ({ items: open, nextCursor: null }),
      accept: async (id) => {
        const hit = open.find((entry) => entry.id === id);
        if (!hit) throw new Error(`idea not found: ${id}`);
        decided.push(`accept:${id}`);
        open = open.filter((entry) => entry.id !== id);
        return { ...hit, status: "accepted", conversationId: `started-${id}` };
      },
    },
    proactive: {
      ...base.proactive,
      feedback: async ({ target, action, scope }) => {
        const hit = open.find((entry) => entry.id === target.id);
        if (!hit) throw new Error(`idea not found: ${target.id}`);
        decided.push(`${action}${scope ? `/${scope}` : ""}:${target.id}`);
        open = open.filter((entry) => entry.id !== target.id);
        const idea: Idea = { ...hit, status: "dismissed" };
        if (action !== "less" && action !== "never") return { idea };
        const rule: ProactiveRule = {
          id: "rule-1",
          kind: action === "never" ? "dont" : "less",
          scope: scope ?? "topic",
          text: "Fewer about Lisbon",
          source: "Button on an idea",
          date: "2026-10-23",
          dueForReview: false,
        };
        return { idea, rule };
      },
      deleteRule: async (id) => {
        decided.push(`undo:${id}`);
        return {};
      },
    },
  };
  return { client, decided };
}

function renderIdeas(client: MockClient) {
  return render(
    <MemoryRouter initialEntries={["/ideas"]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
            <Routes>
              <Route path="/ideas" element={<><Path /><IdeasPage /></>} />
              <Route path="/c/:conversationId" element={<Path />} />
            </Routes>
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("Ideas page", () => {
  it("Do it starts the idea and opens the conversation it started; the reason and the draft show on the card", async () => {
    const { client, decided } = await ideasClient(303, (agent) => [
      {
        ...idea(1, agent.id),
        text: "Lisbon fares dropped. Book now?",
        why: "You are tracking the Lisbon trip goal.",
        prepared: { kind: "draft", ref: "drafts/2026-10-15-lisbon.md", label: "Booking note" },
      },
    ]);
    renderIdeas(client);
    await screen.findByText("Lisbon fares dropped. Book now?");
    expect(screen.getByText("You are tracking the Lisbon trip goal.")).toBeTruthy();
    expect(screen.getByText("Draft: Booking note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/c/started-idea-1"));
    expect(decided).toEqual(["accept:idea-1"]);
  });

  it("Less like this offers three written-out choices; the toast shows the rule and Undo deletes it", async () => {
    const { client, decided } = await ideasClient(306, (agent) => [{ ...idea(3, agent.id), text: "Lisbon again?" }]);
    renderIdeas(client);
    await screen.findByText("Lisbon again?");
    fireEvent.keyDown(screen.getByRole("button", { name: "Less like this" }), { key: "Enter" });
    expect(await screen.findByRole("menuitem", { name: "Fewer ideas like this" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Never suggest this" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Fewer about this topic" }));
    await waitFor(() => expect(screen.queryByText("Lisbon again?")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(decided).toEqual(["less/topic:idea-3", "undo:rule-1"]));
  });

  it("Not now snoozes the idea and it stays gone; with none left a line says when ideas appear", async () => {
    const { client, decided } = await ideasClient(304, (agent) => [{ ...idea(7, agent.id), text: "Dismiss me please" }]);
    renderIdeas(client);
    await screen.findByText("Dismiss me please");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText("Dismiss me please")).toBeNull());
    expect(decided).toEqual(["not_now:idea-7"]);
    await screen.findByText(/Ideas show up here each morning/);
    expect(screen.getByTestId("path").textContent).toBe("/ideas");
  });

  it("caps each section at five and reveals the rest on request", async () => {
    const { client } = await ideasClient(305, (agent) => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => idea(n, agent.id)));
    renderIdeas(client);
    await screen.findByText("Offer number 1");
    expect(screen.queryByText("Offer number 6")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more (3)" }));
    expect(screen.getByText("Offer number 8")).toBeTruthy();
  });
});
