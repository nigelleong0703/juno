import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

interface SeenCall {
  url: string;
  init: RequestInit;
}

function clientFor(seen: SeenCall[], status = 204) {
  const fetch = async (url: unknown, init?: unknown) => {
    seen.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(status === 204 ? null : JSON.stringify({ ok: true }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return createHttpClient({
    baseUrl: "http://api.test",
    getToken: () => "tok",
    fetch: vi.fn(fetch),
  });
}

describe("conversations.typing", () => {
  it("posts only an activity boolean to the typing endpoint", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen);
    await client.conversations.typing("c-1", true);
    expect(seen).toHaveLength(1);
    const call = seen[0] as SeenCall;
    expect(new URL(call.url).pathname).toBe("/v1/conversations/c-1/typing");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ active: true });
  });

  it("resolves on the best-effort 204 with no body", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, 204);
    await expect(client.conversations.typing("c-1", false)).resolves.toBeUndefined();
  });
});
