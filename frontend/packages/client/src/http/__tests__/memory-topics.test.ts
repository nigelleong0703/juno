import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const ISO = "2026-10-26T00:00:00.000Z";

function clientFor(routes: Record<string, unknown>, seen: string[]) {
  const fetch = async (url: unknown) => {
    seen.push(String(url));
    return new Response(JSON.stringify(routes[new URL(String(url)).pathname]), { headers: { "content-type": "application/json" } });
  };
  return createHttpClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch: vi.fn(fetch) });
}

describe("memory topics (contract 0.63.0)", () => {
  it("topics reads GET /v1/memory/topics, summary may be empty", async () => {
    const seen: string[] = [];
    const topic = { topic: "health", label: "Health", summary: "", segments: [], count: 2, updatedAt: ISO };
    const client = clientFor({ "/v1/memory/topics": { items: [topic] } }, seen);
    const { items } = await client.memoryItems.topics();
    expect(items).toEqual([topic]);
    expect(seen).toEqual(["http://api.test/v1/memory/topics"]);
  });

  it("topics carries the summary in segments, a phrase naming its item", async () => {
    const segments = [{ text: "You are " }, { text: "cutting sugar", itemId: "m-1" }, { text: "." }];
    const client = clientFor(
      { "/v1/memory/topics": { items: [{ topic: "health", label: "Health", summary: "You are cutting sugar.", segments, count: 1, updatedAt: ISO }] } },
      [],
    );
    const { items } = await client.memoryItems.topics();
    expect(items[0]?.segments).toEqual(segments);
  });

  it("list sends ?topic= and returns each item's topic", async () => {
    const seen: string[] = [];
    const item = {
      id: "m-1",
      text: "Is cutting sugar",
      kind: "preference",
      topic: "health",
      about: null,
      saidBy: null,
      saidIn: { label: "Your chat" },
      audience: { kind: "owner", label: "Only you" },
      sensitive: false,
      status: "active",
      createdAt: ISO,
      quote: null,
    };
    const client = clientFor({ "/v1/memory/items": { items: [item], nextCursor: null } }, seen);
    const page = await client.memoryItems.list({ topic: "health" });
    expect(page.items[0]?.topic).toBe("health");
    expect(new URL(seen[0] ?? "").searchParams.get("topic")).toBe("health");
  });
});
