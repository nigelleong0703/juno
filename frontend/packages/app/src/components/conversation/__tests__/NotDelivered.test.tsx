/**
 * A reply that never reached its platform chat says so under the bubble, with Retry (BACKEND 5.7.11). The mock client holds the dropped
 * row; Retry finds it by the item id, and the line goes when the item's `delivery` is no longer dropped (the live `item.added`).
 */
import type { Item, OutboxEntry } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { Transcript } from "../Transcript";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(cleanup);

const AT = "2026-11-01T10:00:00.000Z";
const origin = { kind: "telegram", channelId: "ch1", chatId: "D1", chatType: "private" as const };

const reply = (id: string, extra: Partial<Extract<Item, { type: "agent_message" }>> = {}): Item => ({
  id, conversationId: "c1", at: AT, type: "agent_message", agentId: "a1", markdown: "Here you go", citations: [], ...extra,
});

const dropped = (id: string, sourceId: string): OutboxEntry => ({
  id, kind: "channel_reply", status: "dropped", conversationId: "c1", sourceId, platform: "telegram", attempts: 8, reason: "retries_exhausted", createdAt: AT, droppedAt: AT,
});

function renderItems(client: MockClient, items: Item[]) {
  return render(
    <ClientProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Transcript items={items} />
        </TooltipProvider>
      </ThemeProvider>
    </ClientProvider>,
  );
}

describe("Not delivered", () => {
  it("shows only under a dropped reply to a platform chat", () => {
    const client = createMockClient({ seed: 3 });
    renderItems(client, [
      reply("m1", { replyTo: origin, delivery: { status: "dropped", reason: "channel_gone" } }),
      reply("m2", { replyTo: origin, delivery: { status: "pending" } }),
      reply("m3", { replyTo: origin, delivery: { status: "sent" } }),
      reply("m4"),
    ]);
    expect(screen.getAllByText("Not delivered")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  it("Retry sends the dropped delivery of that reply back to pending, and the line goes once the item says so", async () => {
    const client = createMockClient({ seed: 3 });
    client.delivery.rows.push(dropped("out-other", "m0"), dropped("out-1", "m1"));
    const item = reply("m1", { replyTo: origin, delivery: { status: "dropped", reason: "retries_exhausted" } });
    const view = renderItems(client, [item]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(client.delivery.rows.find((row) => row.id === "out-1")?.status).toBe("pending"));
    expect(client.delivery.rows.find((row) => row.id === "out-other")?.status).toBe("dropped");
    view.rerender(
      <ClientProvider client={client} queryClient={new QueryClient()}>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>
            <Transcript items={[{ ...item, delivery: { status: "pending" } } as Item]} />
          </TooltipProvider>
        </ThemeProvider>
      </ClientProvider>,
    );
    expect(screen.queryByText("Not delivered")).toBeNull();
  });
});
