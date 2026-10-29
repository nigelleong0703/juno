import type { AgentTask, ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ActivityTab } from "../card/activityTabs";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});
afterEach(cleanup);

function task(over: Partial<AgentTask> & Pick<AgentTask, "id" | "title">): AgentTask {
  return {
    kind: "subagent",
    agentId: "agent-juno",
    conversationId: "conv-juno",
    rootRunId: "run-root",
    depth: 0,
    origin: { type: "owner_message", conversationId: "conv-juno" },
    mode: "awaited",
    replyTo: { type: "none" },
    status: "running",
    startedAt: "2026-10-29T08:00:00.000Z",
    updatedAt: "2026-10-29T08:00:00.000Z",
    ...over,
  };
}

describe("a folded parent does not hide a descendant that needs the person", () => {
  it("shows the most urgent state on the parent, counts them, and starts open down to the grandchild", async () => {
    const base = createMockClient({ seed: 3 });
    const agent = await base.agents.get("agent-juno");
    const tasks = [
      task({ id: "top", title: "Plan the trip", childRunId: "run-top" }),
      task({ id: "mid", title: "Book flights", parentId: "run-top", depth: 1, childRunId: "run-mid" }),
      task({ id: "leaf", title: "Pay for the ticket", kind: "task", parentId: "run-mid", depth: 2, status: "waiting", waitingFor: "approval", progress: "Pay 420 EUR?" }),
    ];
    const client: ApiClient = { ...base, agents: { ...base.agents, tasks: async () => ({ items: tasks, nextCursor: null }) } };
    render(
      <MemoryRouter>
        <ThemeProvider defaultTheme="light">
          <TooltipProvider>
            <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
              <ActivityTab agent={agent} />
            </ClientProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Plan the trip")).toBeDefined();
    // The grandchild is on screen without a tap: both levels start expanded.
    expect(screen.getByText("Book flights")).toBeDefined();
    expect(screen.getByText("Waiting for approval · Pay 420 EUR?")).toBeDefined();
    // The parents carry the pill and the line (the grandchild counts for both).
    expect(screen.getAllByText("Waiting for approval").length).toBe(2);
    expect(screen.getAllByText("1 needs you").length).toBe(2);
  });
});
