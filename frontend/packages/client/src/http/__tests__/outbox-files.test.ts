import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const AT = "2026-11-01T10:00:00.000Z";

function clientReturning(payload: unknown) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
  return { client: createHttpClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch }), fetch };
}

function sent(fetch: ReturnType<typeof clientReturning>["fetch"]) {
  const [url, init] = fetch.mock.calls[0] ?? [];
  const parsed = new URL(String(url));
  return { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

describe("outbox API", () => {
  it("lists dropped deliveries of one conversation and reads the pause state", async () => {
    const { client, fetch } = clientReturning({
      items: [{ id: "out-1", kind: "channel_reply", status: "dropped", conversationId: "c1", sourceId: "m1", platform: "telegram", attempts: 8, reason: "channel_gone", createdAt: AT, droppedAt: AT }],
      frozen: { owner: false, operator: true },
      health: { status: "red", failing: [{ platform: "slack", channelId: "ch", consecutiveFailures: 3, lastError: "x", since: AT }] },
    });
    const list = await client.outbox.list({ status: "dropped", conversationId: "c1", limit: 100 });
    expect(sent(fetch)).toMatchObject({ path: "/v1/outbox", query: { status: "dropped", conversationId: "c1", limit: "100" }, method: "GET" });
    expect(list.items[0]?.sourceId).toBe("m1");
    expect(list.frozen.operator).toBe(true);
    expect(list.health.failing[0]?.platform).toBe("slack");
  });

  it("retries one delivery and sets the owner's pause", async () => {
    const retry = clientReturning({ id: "out-1" });
    await retry.client.outbox.retry("out-1");
    expect(sent(retry.fetch)).toMatchObject({ path: "/v1/outbox/out-1/retry", method: "POST" });
    const freeze = clientReturning({ frozen: true });
    expect(await freeze.client.outbox.freeze({ frozen: true })).toEqual({ frozen: true });
    expect(sent(freeze.fetch)).toMatchObject({ path: "/v1/outbox/freeze", method: "POST", body: { frozen: true } });
  });
});

describe("files API", () => {
  const SNAPSHOT = { id: "snap-1", agentId: "a1", path: "/workspace/a b.md", on: "sandbox", tool: "files.write", sizeBytes: 12, sha256: "h", createdAt: AT };

  it("reads a path's history by agent and restores a version", async () => {
    const history = clientReturning({ items: [SNAPSHOT] });
    const read = await history.client.files.history({ path: "/workspace/a b.md", agentId: "a1", on: "sandbox" });
    expect(sent(history.fetch)).toMatchObject({ path: "/v1/files/history", query: { path: "/workspace/a b.md", agentId: "a1", on: "sandbox" }, method: "GET" });
    expect(read.items).toHaveLength(1);
    const restored = clientReturning({ path: SNAPSHOT.path, on: "sandbox", bytes: 12, restored: SNAPSHOT });
    await restored.client.files.restore({ snapshotId: "snap-1" });
    expect(sent(restored.fetch)).toMatchObject({ path: "/v1/files/restore", method: "POST", body: { snapshotId: "snap-1" } });
  });
});
