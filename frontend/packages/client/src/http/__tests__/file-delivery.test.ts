import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const ENTRY = {
  id: "lib-1",
  name: "notes.md",
  kind: "document",
  mimeType: "text/markdown",
  sizeBytes: 12,
  shared: "team",
  source: "agent",
  tags: [],
  pinned: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const DOWNLOAD = {
  name: "notes.md",
  mimeType: "text/markdown",
  contentBase64: "aGVsbG8gd29ybGQ=",
};

type Seen = { url: string; method: string; authorization: string | null; body: unknown };

function fakeFetch(routes: Record<string, unknown>, seen: Seen[]) {
  return async (url: unknown, init?: RequestInit) => {
    const raw = String(url);
    const parsed = new URL(raw);
    const headers = new Headers(init?.headers);
    seen.push({
      url: raw,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(routes[parsed.pathname]), {
      headers: { "content-type": "application/json" },
    });
  };
}

function clientFor(routes: Record<string, unknown>, seen: Seen[]) {
  return createHttpClient({
    baseUrl: "http://api.test",
    getToken: () => "tok",
    fetch: vi.fn(fakeFetch(routes, seen)),
  });
}

describe("library file delivery", () => {
  it("lists and reads entries with bearer auth", async () => {
    const seen: Seen[] = [];
    const client = clientFor({ "/v1/library": { items: [ENTRY], nextCursor: null }, "/v1/library/lib-1": ENTRY }, seen);

    const listed = await client.library.list({ limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.name).toBe("notes.md");

    const entry = await client.library.get("lib-1");
    expect(entry.id).toBe("lib-1");

    expect(seen.map((s) => s.url)).toEqual([
      "http://api.test/v1/library?limit=10",
      "http://api.test/v1/library/lib-1",
    ]);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.authorization).toBe("Bearer tok");
    }
  });

  it("forwards the conversation scope as a URL query", async () => {
    const seen: Seen[] = [];
    const client = clientFor({ "/v1/library": { items: [ENTRY], nextCursor: null } }, seen);

    const listed = await client.library.list({ conversationId: "conv-juno", limit: 10 });
    expect(listed.items).toHaveLength(1);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://api.test/v1/library?conversationId=conv-juno&limit=10");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.authorization).toBe("Bearer tok");
  });

  it("pins and deletes through the owner endpoints", async () => {
    const seen: Seen[] = [];
    const client = clientFor({ "/v1/library/lib-1/pinned": { ...ENTRY, pinned: true }, "/v1/library/lib-1": {} }, seen);

    const pinned = await client.library.setPinned("lib-1", true);
    expect(pinned.pinned).toBe(true);
    await client.library.delete("lib-1");

    expect(seen[0]?.url).toBe("http://api.test/v1/library/lib-1/pinned");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toEqual({ pinned: true });
    expect(seen[0]?.authorization).toBe("Bearer tok");
    expect(seen[1]?.url).toBe("http://api.test/v1/library/lib-1");
    expect(seen[1]?.method).toBe("DELETE");
    expect(seen[1]?.authorization).toBe("Bearer tok");
  });

  it("downloads bytes over the same authenticated request", async () => {
    const seen: Seen[] = [];
    const client = clientFor({ "/v1/library/lib-1/download": DOWNLOAD }, seen);

    const file = await client.library.download("lib-1");
    expect(file.name).toBe("notes.md");
    expect(file.mimeType).toBe("text/markdown");
    expect(file.contentBase64).toBe("aGVsbG8gd29ybGQ=");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://api.test/v1/library/lib-1/download");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.authorization).toBe("Bearer tok");
  });
});
