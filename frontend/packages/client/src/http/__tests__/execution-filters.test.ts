import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const ISO = "2026-10-08T00:00:00.000Z";

/** Keys the agentd list query parser actually reads for /v1/runs, /v1/requests and /v1/runs/:id/steps. */
const SUPPORTED = new Set(["limit", "cursor", "status", "kind", "agentId", "conversationId", "runId", "parentId", "ids"]);

const RUN = {
  id: "run-1",
  agentId: "agent-1",
  conversationId: "conv-1",
  title: "Inbox triage",
  status: "running",
  kind: "chat",
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
  startedAt: ISO,
  lastActivityAt: ISO,
};

const REQUEST = {
  id: "req-1",
  kind: "approval",
  status: "expired",
  title: "Send email",
  summary: "",
  agentId: "agent-1",
  conversationId: "conv-1",
  payload: { kind: "approval", action: "Send email", why: "asked to" },
  createdAt: ISO,
};

function clientFor(routes: Record<string, unknown>, seen: string[]) {
  const fetch = async (url: unknown) => {
    const parsed = new URL(String(url));
    seen.push(String(url));
    return new Response(JSON.stringify(routes[parsed.pathname]), {
      headers: { "content-type": "application/json" },
    });
  };
  return createHttpClient({
    baseUrl: "http://api.test",
    getToken: () => "tok",
    fetch: vi.fn(fetch),
  });
}

function queryOf(seen: string[]): URL {
  const first = seen[0];
  if (first === undefined || first === "") {
    throw new Error("expected one captured request URL");
  }
  return new URL(first);
}

function expectOnlySupported(url: URL): void {
  for (const key of url.searchParams.keys()) {
    expect(SUPPORTED.has(key)).toBe(true);
  }
}

describe("requests.list query", () => {
  it("transmits the pending status so an expired request is not returned", async () => {
    const seen: string[] = [];
    const client = clientFor({ "/v1/requests": { items: [REQUEST], nextCursor: null } }, seen);
    const result = await client.requests.list({ status: "pending" });
    expect(result.items).toHaveLength(1);
    const url = queryOf(seen);
    expect(url.pathname).toBe("/v1/requests");
    expect(url.searchParams.get("status")).toBe("pending");
    expectOnlySupported(url);
  });

  it("forwards kind and agentId with preserved pagination", async () => {
    const seen: string[] = [];
    const client = clientFor({ "/v1/requests": { items: [REQUEST], nextCursor: "cursor-2" } }, seen);
    const result = await client.requests.list({
      status: "pending",
      kind: "approval",
      agentId: "agent-1",
      limit: 25,
      cursor: "cursor-1",
    });
    expect(result.nextCursor).toBe("cursor-2");
    const url = queryOf(seen);
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("kind")).toBe("approval");
    expect(url.searchParams.get("agentId")).toBe("agent-1");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
    expectOnlySupported(url);
  });

  it("transmits nothing but pagination when no filters are given", async () => {
    const seen: string[] = [];
    const client = clientFor({ "/v1/requests": { items: [], nextCursor: null } }, seen);
    await client.requests.list({ limit: 10 });
    const url = queryOf(seen);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("status")).toBeNull();
    expect(url.searchParams.get("kind")).toBeNull();
    expect(url.searchParams.get("agentId")).toBeNull();
    expectOnlySupported(url);
  });
});

describe("runs.list query", () => {
  it("transmits status, conversationId, agentId and kind", async () => {
    const seen: string[] = [];
    const client = clientFor({ "/v1/runs": { items: [RUN], nextCursor: null } }, seen);
    const result = await client.runs.list({
      status: "running",
      conversationId: "conv-1",
      agentId: "agent-1",
      kind: "chat",
    });
    expect(result.items).toHaveLength(1);
    const url = queryOf(seen);
    expect(url.pathname).toBe("/v1/runs");
    expect(url.searchParams.get("status")).toBe("running");
    expect(url.searchParams.get("conversationId")).toBe("conv-1");
    expect(url.searchParams.get("agentId")).toBe("agent-1");
    expect(url.searchParams.get("kind")).toBe("chat");
    expectOnlySupported(url);
  });

});

describe("runs.steps query", () => {
  it("keeps pagination and sends no unsupported keys", async () => {
    const seen: string[] = [];
    const client = clientFor({ "/v1/runs/run-1/steps": { items: [], nextCursor: null } }, seen);
    await client.runs.steps("run-1", { limit: 20, cursor: "cursor-3" });
    const url = queryOf(seen);
    expect(url.pathname).toBe("/v1/runs/run-1/steps");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("cursor")).toBe("cursor-3");
    expectOnlySupported(url);
  });
});
