import type { AgentTask, ApiClient, Item } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ConversationPage } from "../../../templates/ConversationPage";
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

const TITLE = "Compare Firecracker and gVisor sandboxes";
const ITEMS: Item[] = [
  { id: "u1", conversationId: "conv-juno", at: "2026-10-05T14:00:00.000Z", type: "user_message", authorId: "member-robin", text: "Compare them", attachments: [], mentions: [] },
  { id: "a1", conversationId: "conv-juno", at: "2026-10-05T14:01:00.000Z", type: "agent_message", agentId: "agent-juno", runId: "run-research", markdown: "Here is the comparison.", citations: [] },
];
// The run completed and the agent replied, but the agent's own task recorded a failed outcome.
const TASK: AgentTask = {
  id: "task-failed",
  agentId: "agent-juno",
  conversationId: "conv-juno",
  runId: "run-research",
  kind: "task",
  rootRunId: "run-research",
  depth: 0,
  origin: { type: "owner_message", conversationId: "conv-juno" },
  mode: "background",
  replyTo: { type: "none" },
  title: TITLE,
  status: "ended",
  outcome: "failed",
  resultLine: "Could not reach the benchmark site",
  startedAt: "2026-10-05T14:00:00.000Z",
  updatedAt: "2026-10-05T14:01:00.000Z",
};

describe("one task detail from every entry point", () => {
  it("a completed run whose task failed: no footer under the reply, the Activity row opens the detail", async () => {
    const base = createMockClient({ seed: 3 });
    const agent = await base.agents.get("agent-juno");
    const client: ApiClient = {
      ...base,
      conversations: { ...base.conversations, items: async () => ({ items: ITEMS, nextCursor: null }) },
      agents: { ...base.agents, tasks: async () => ({ items: [TASK], nextCursor: null }) },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <ThemeProvider defaultTheme="light">
          <TooltipProvider>
            <ClientProvider client={client} platform={webPlatform} queryClient={queryClient}>
              <ConversationPage conversationId="conv-juno" />
              <ActivityTab agent={agent} />
            </ClientProvider>
          </TooltipProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );

    // The row: the task title, the agent's outcome in muted text (never red), when it started.
    const outcome = await screen.findByText("Could not reach the benchmark site");
    expect(outcome.className).not.toContain("text-danger");
    const row = screen.getByRole("button", { name: new RegExp(TITLE) });

    // No "Worked · N steps" footer under the reply: the steps live behind the agent's Activity row.
    expect(await screen.findByText("Here is the comparison.")).toBeDefined();
    expect(document.querySelector('[data-slot="run-footer"]')).toBeNull();
    expect(screen.queryByText(/^Worked\b/)).toBeNull();

    const detail = async () => {
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(within(dialog).getByText("Didn't finish")).toBeDefined());
      expect(within(dialog).getByText(TITLE)).toBeDefined();
      expect(within(dialog).getByText("Could not reach the benchmark site")).toBeDefined();
      const text = dialog.textContent;
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      return text;
    };

    fireEvent.click(row);
    await detail();

    // The seeded chat has a request waiting, whose card is inline: the working pill stays out.
    expect(document.querySelector('[data-slot="agent-status-open"]')).toBeNull();
  });
});
