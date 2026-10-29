import { describe, expect, it, vi } from "vitest";
import { createAccountClient, normalizeServerUrl, sessionSecretKey } from "../account";

describe("account transport boundaries", () => {
  it("does not release a late domain response or unauthorized event after disposal", async () => {
    let answer: ((response: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal;
      return new Promise((resolve) => { answer = resolve; });
    });
    const onUnauthorized = vi.fn();
    const transport = createAccountClient("https://example.test", "account-token", fetcher, onUnauthorized);
    const result = transport.client.agents.list().catch((error: unknown) => error);
    await vi.waitFor(() => expect(answer).toBeDefined());
    transport.dispose();
    expect(signal?.aborted).toBe(true);
    answer?.(new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }));
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    const calls = fetcher.mock.calls.length;
    await expect(transport.client.agents.list()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher.mock.calls).toHaveLength(calls);
  });

  it("keys native secrets by normalized server origin", () => {
    expect(normalizeServerUrl("HTTPS://Example.Test:443/")).toBe("https://example.test");
    expect(sessionSecretKey("https://example.test/a")).toBe(sessionSecretKey("https://example.test/b"));
    expect(sessionSecretKey("https://other.test")).not.toBe(sessionSecretKey("https://example.test"));
    expect(() => normalizeServerUrl("file:///tmp/server")).toThrow();
    expect(() => normalizeServerUrl("https://user:password@example.test")).toThrow();
  });
});
