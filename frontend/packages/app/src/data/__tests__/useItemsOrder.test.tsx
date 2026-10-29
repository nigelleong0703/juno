import type { ApiClient, Item } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ClientProvider } from "../ClientProvider";
import { useItems } from "../queries";

// The real items endpoint listed the later question and the long answer before the earlier "Hi"
// (owner baseline 2026-10-05). The mock normally sorts, so this test overrides the endpoint to
// hand the hook that exact out-of-order payload.
const OUT_OF_ORDER: Item[] = [
  {
    id: "itm-q-late",
    conversationId: "conv-juno",
    at: "2026-10-05T14:54:49.085Z",
    type: "user_message",
    authorId: "member-robin",
    text: "second question",
    attachments: [],
    mentions: [],
  },
  {
    id: "itm-a-late",
    conversationId: "conv-juno",
    at: "2026-10-05T14:54:56.284Z",
    type: "agent_message",
    agentId: "agent-juno",
    markdown: "long answer",
    citations: [],
  },
  {
    id: "itm-a-early",
    conversationId: "conv-juno",
    at: "2026-10-05T14:54:42.846Z",
    type: "agent_message",
    agentId: "agent-juno",
    markdown: "Hi",
    citations: [],
  },
];

function clientReturningItems(items: Item[]): ApiClient {
  const base = createMockClient({ seed: 3 });
  return {
    ...base,
    conversations: {
      ...base.conversations,
      items: async () => ({ items, nextCursor: null }),
    },
  };
}

function wrapperFor(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient}>
      {children}
    </ClientProvider>
  );
}

describe("useItems", () => {
  it("returns fetched items in chronological order even when the endpoint lists them oddly", async () => {
    const { result } = renderHook(() => useItems("conv-juno"), {
      wrapper: wrapperFor(clientReturningItems(OUT_OF_ORDER)),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data?.map((item) => item.id)).toEqual([
      "itm-a-early",
      "itm-q-late",
      "itm-a-late",
    ]);
  });
});
