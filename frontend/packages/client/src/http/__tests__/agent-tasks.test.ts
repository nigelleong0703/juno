import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const PLAN = {
  id: "plan-a",
  conversationId: "conv-a",
  agentId: "agent-a",
  type: "plan",
  runId: "run-a",
  at: "2026-10-08T00:00:00.000Z",
  todos: [
    { id: "p1", text: "Outstanding", status: "pending" },
    { id: "b1", text: "Blocked", status: "blocked", note: "Needs credentials" },
  ],
};

function clientReturning(payload: unknown) {
  const fetch = vi.fn(
    async (_url: unknown) =>
      new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
  );
  const client = createHttpClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch });
  return { client, fetch };
}

describe("agents.plans", () => {
  it("gets the agent todo plans from the plans endpoint", async () => {
    const { client, fetch } = clientReturning({ items: [PLAN], nextCursor: null });
    const result = await client.agents.plans("agent-a");
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.todos[1]?.status).toBe("blocked");
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/agents/agent-a/plans");
  });

  it("rejects a malformed plan item rather than returning it", async () => {
    const { client } = clientReturning({ items: [{ id: "x", type: "plan" }], nextCursor: null });
    await expect(client.agents.plans("agent-a")).rejects.toThrow();
  });
});

const TASK = {
  id: "task-a",
  kind: "routine",
  agentId: "agent-a",
  rootRunId: "run-a",
  depth: 0,
  origin: { type: "routine", routineId: "routine-a", occurrenceAt: "2026-10-29T08:00:00.000Z" },
  mode: "scheduled",
  replyTo: { type: "none" },
  status: "ended",
  outcome: "failed",
  outcomeDetail: "timed_out",
  title: "Weekly digest",
  routineId: "routine-a",
  startedAt: "2026-10-29T08:00:00.000Z",
  updatedAt: "2026-10-29T08:05:00.000Z",
};

describe("tasks.list and tasks.tree", () => {
  it("sends every filter as a query parameter and parses the page", async () => {
    const { client, fetch } = clientReturning({ items: [TASK], nextCursor: "next-1" });
    const page = await client.tasks.list({ agentId: "agent-a", kind: "routine", routineId: "routine-a", status: "ended", cursor: "c1", limit: 20 });
    expect(page.nextCursor).toBe("next-1");
    expect(page.items[0]?.outcomeDetail).toBe("timed_out");
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/tasks");
    expect(Object.fromEntries(url.searchParams)).toEqual({ agentId: "agent-a", kind: "routine", routineId: "routine-a", status: "ended", cursor: "c1", limit: "20" });
  });

  it("gets the tree of a task", async () => {
    const usage = { inputTokens: 1, outputTokens: 2, computeSeconds: 3, costUsd: 0, steps: 1 };
    const { client, fetch } = clientReturning({ rootRunId: "run-a", origin: TASK.origin, items: [TASK], subtreeUsage: usage });
    expect((await client.tasks.tree("task-a")).items).toHaveLength(1);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/tasks/task-a/tree");
  });

  it("leaves out a task that holds a value this version does not know, and still refuses a malformed one", async () => {
    // A newer server's status must not hide the whole list; the other tasks still arrive.
    const future = clientReturning({ items: [{ ...TASK, status: "a_status_from_a_newer_server" }, { ...TASK, id: "task-b" }], nextCursor: null });
    expect((await future.client.tasks.list()).items.map((task) => task.id)).toEqual(["task-b"]);
    // Anything else wrong with a row is a real error.
    const broken = clientReturning({ items: [{ ...TASK, id: 7 }], nextCursor: null });
    await expect(broken.client.tasks.list()).rejects.toThrow();
  });
});
