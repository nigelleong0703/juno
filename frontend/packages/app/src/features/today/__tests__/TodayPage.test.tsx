import type { FeedPost, Idea, Request } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { TodayPage } from "../TodayPage";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});
afterEach(cleanup);

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderToday(client: MockClient) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <Routes>
              <Route path="*" element={<><Path /><TodayPage /></>} />
            </Routes>
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** Four pending approvals: the seeded approval copied, so Needs you has more than its three-row cap. */
async function fourRequests(base: MockClient): Promise<Request[]> {
  const pending = await base.requests.list({ status: "pending" });
  const sample = pending.items.find((request) => request.kind === "approval");
  if (!sample) throw new Error("the mock world has no pending approval");
  return Array.from({ length: 4 }, (_, index) => ({ ...sample, id: `req-copy-${index}` }));
}

/** Four feed posts with different titles, so Updates has more than its three-row cap. */
function fourPosts(): FeedPost[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `post-${index}`,
    agentId: "agent-juno",
    title: `Post number ${index + 1}`,
    summary: `What the agent found in pass ${index + 1}.`,
    liked: false,
    createdAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
  }));
}

/** Four open ideas from the mock's own agents, so Ideas has more than its three-card cap. */
function fourIdeas(): Idea[] {
  const agents = ["agent-juno", "agent-patch"];
  return Array.from({ length: 4 }, (_, index) => ({
    id: `idea-${index}`,
    agentId: agents[index % agents.length] as string,
    text: `Idea number ${index + 1}`,
    prompt: `Do idea ${index + 1}`,
    status: "open",
    createdAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
  }));
}

describe("Today page", () => {
  it("Needs you shows three requests with Open chat, and All reveals the rest", async () => {
    const base = createMockClient({ seed: 7 });
    const requests = await fourRequests(base);
    renderToday({ ...base, requests: { ...base.requests, list: async () => ({ items: requests, nextCursor: null }) } });
    const open = await screen.findAllByRole("button", { name: "Open chat" });
    expect(open).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "All · 4" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open chat" })).toHaveLength(4));
  });

  it("Updates show three posts, and All opens the full Feed", async () => {
    const base = createMockClient({ seed: 7 });
    const posts = fourPosts();
    renderToday({ ...base, feed: { ...base.feed, list: async () => ({ items: posts, nextCursor: null }) } });
    await screen.findByText("Post number 3");
    expect(screen.queryByText("Post number 4")).toBeNull();
    // "All ›" sits on the block's header row, each one named for its block.
    fireEvent.click(screen.getByRole("button", { name: "All Updates" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/feed"));
  });

  it("shows the agents as stories under the greeting, each opening its page", async () => {
    const base = createMockClient({ seed: 7 });
    const [agent] = (await base.agents.list()).items;
    if (!agent) throw new Error("the mock world has no agent");
    renderToday(base);
    expect(screen.queryByRole("button", { name: "Me" })).toBeNull();
    fireEvent.click(await screen.findByRole("link", { name: `Open ${agent.name}'s page` }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe(`/agents/${agent.id}`));
  });

  it("Ideas show three cards, and Never sends the feedback for that idea", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    renderToday({
      ...base,
      ideas: {
        ...base.ideas,
        list: async () => ({ items: fourIdeas(), nextCursor: null }),
      },
      proactive: {
        ...base.proactive,
        feedback: async (input) => {
          calls.push(`${input.action}:${input.target.id}`);
          return base.proactive.feedback(input);
        },
      },
    });
    const never = await screen.findAllByRole("button", { name: "Never" });
    expect(never).toHaveLength(3);
    fireEvent.click(never[0] as HTMLElement);
    await waitFor(() => expect(calls).toEqual(["never:idea-0"]));
  });

  it("Needs you adds the memory items to review after the pending requests", async () => {
    const base = createMockClient({ seed: 7 });
    const today = await base.feed.today();
    renderToday({
      ...base,
      requests: { ...base.requests, list: async () => ({ items: [], nextCursor: null }) },
      feed: {
        ...base.feed,
        today: async () => ({
          ...today,
          needsYou: {
            ...today.needsYou,
            items: [{ kind: "memory_review" as const, itemId: "mem-1", text: "Prefers morning calls" }],
          },
        }),
      },
    });
    expect(await screen.findByText("Prefers morning calls")).toBeTruthy();
    expect(screen.getByText("Review memory")).toBeTruthy();
  });
});
