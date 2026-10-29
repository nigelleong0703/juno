import type { ApiClient, Item } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../ClientProvider";
import { MARK_READ_DELAY_MS, useMarkOpenConversationRead } from "../markOpenRead";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const item = (id: string, type: string): Item => ({ id, type, conversationId: "c1", at: "2026-10-16T05:00:00.000Z" }) as unknown as Item;

describe("useMarkOpenConversationRead", () => {
  it("marks the open chat read once after a quiet second when someone else's item arrives", async () => {
    vi.useFakeTimers();
    const client: ApiClient = createMockClient();
    const markRead = vi.spyOn(client.conversations, "markRead").mockResolvedValue(undefined as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} queryClient={queryClient}>{children}</ClientProvider>
    );
    const { rerender } = renderHook(({ items }) => useMarkOpenConversationRead("c1", items), {
      wrapper,
      initialProps: { items: [item("u1", "user_message")] },
    });
    await vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS);
    expect(markRead).toHaveBeenCalledTimes(1);

    // Three bubbles of one reply land close together: one mark-read, not three.
    rerender({ items: [item("u1", "user_message"), item("a1", "agent_message")] });
    await vi.advanceTimersByTimeAsync(200);
    rerender({ items: [item("u1", "user_message"), item("a1", "agent_message"), item("a2", "agent_message")] });
    await vi.advanceTimersByTimeAsync(200);
    rerender({ items: [item("u1", "user_message"), item("a1", "agent_message"), item("a2", "agent_message"), item("a3", "agent_message")] });
    await vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS);
    expect(markRead).toHaveBeenCalledTimes(2);

    // The user's own message does not need a mark-read.
    rerender({ items: [item("u1", "user_message"), item("a1", "agent_message"), item("a2", "agent_message"), item("a3", "agent_message"), item("u2", "user_message")] });
    await vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS);
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenLastCalledWith("c1");
  });
});
