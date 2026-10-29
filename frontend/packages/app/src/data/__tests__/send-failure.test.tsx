import type { AdmissionIdentity, ComposerPayload, Item } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../ClientProvider";
import { useDiscardSend, useSendMessage } from "../mutations";
import { useOutbox, withRefused } from "../outbox";
import { qk } from "../keys";

const CONVERSATION = "conv-send-failure";

beforeEach(() => {
  useOutbox.setState({ failed: {} });
});

function setup(send: MockClient["conversations"]["send"]) {
  const base = createMockClient({ seed: 411 });
  const client: MockClient = { ...base, conversations: { ...base.conversations, send } };
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData<Item[]>(qk.items(CONVERSATION), []);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient}>
      {children}
    </ClientProvider>
  );
  return { queryClient, wrapper };
}

describe("refused send", () => {
  it("keeps the placeholder in the transcript and records the failure instead of dropping it", async () => {
    const payload = { text: "Book the flights", attachments: [], mentions: [] } as ComposerPayload;
    const { queryClient, wrapper } = setup(async () => {
      throw new Error("Network down");
    });
    const { result } = renderHook(() => useSendMessage(CONVERSATION), { wrapper });

    act(() => result.current.mutate(payload));
    await waitFor(() => expect(result.current.isError).toBe(true));

    const items = queryClient.getQueryData<Item[]>(qk.items(CONVERSATION)) ?? [];
    expect(items).toHaveLength(1);
    const [placeholder] = items;
    expect(placeholder?.id.startsWith("msg-client-")).toBe(true);
    expect(useOutbox.getState().failed[placeholder?.id ?? ""]).toEqual({
      tempId: placeholder?.id,
      identity: expect.objectContaining({ messageId: placeholder?.id, runId: expect.any(String) }),
      conversationId: CONVERSATION,
      payload,
      reason: "Network down",
      item: placeholder,
    });
  });

  it("a refetch that drops the placeholder does not drop the refused message", async () => {
    const { queryClient, wrapper } = setup(async () => {
      throw new Error("Network down");
    });
    const { result } = renderHook(() => useSendMessage(CONVERSATION), { wrapper });
    act(() => result.current.mutate({ text: "Keep me", attachments: [], mentions: [] } as ComposerPayload));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // The server list has no such message: the refused one must still be in the shown list.
    const shown = withRefused([], useOutbox.getState().failed, CONVERSATION);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.type === "user_message" && shown[0].text).toBe("Keep me");
    expect(queryClient.getQueryData<Item[]>(qk.items(CONVERSATION))).toHaveLength(1);
  });

  it("retries a lost response with the same message/run identity; a new identical send is a new intent", async () => {
    const identities: Array<AdmissionIdentity | undefined> = [];
    let loseResponse = true;
    const { wrapper } = setup(async (_id, payload, identity) => {
      identities.push(identity);
      if (loseResponse) throw new TypeError("Response lost after admission");
      return { runId: identity?.runId ?? null, item: {
        id: identity?.messageId ?? "missing", type: "user_message", conversationId: CONVERSATION,
        at: new Date().toISOString(), authorId: "me", text: payload.text, attachments: [], mentions: [],
      } };
    });
    const { result } = renderHook(() => useSendMessage(CONVERSATION), { wrapper });
    const payload = { text: "same intent", attachments: [], mentions: [] } as ComposerPayload;
    act(() => result.current.mutate(payload));
    await waitFor(() => expect(result.current.isError).toBe(true));
    const failure = Object.values(useOutbox.getState().failed)[0];
    expect(failure).toBeDefined();
    loseResponse = false;
    act(() => result.current.retry(failure!.tempId));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(identities[1]).toEqual(identities[0]);
    expect(useOutbox.getState().failed).toEqual({});
    act(() => result.current.mutate(payload));
    await waitFor(() => expect(identities).toHaveLength(3));
    expect(identities[2]?.messageId).not.toBe(identities[0]?.messageId);
    expect(identities[2]?.runId).not.toBe(identities[0]?.runId);
  });

  it("Delete removes the placeholder and forgets the failure", async () => {
    const { queryClient, wrapper } = setup(async () => {
      throw new Error("Nope");
    });
    const { result } = renderHook(
      () => ({ send: useSendMessage(CONVERSATION), discard: useDiscardSend(CONVERSATION) }),
      { wrapper },
    );

    act(() => result.current.send.mutate({ text: "Hi", attachments: [], mentions: [] } as ComposerPayload));
    await waitFor(() => expect(result.current.send.isError).toBe(true));
    const tempId = (queryClient.getQueryData<Item[]>(qk.items(CONVERSATION)) ?? [])[0]?.id ?? "";

    act(() => result.current.discard(tempId));

    expect(queryClient.getQueryData<Item[]>(qk.items(CONVERSATION))).toEqual([]);
    expect(useOutbox.getState().failed).toEqual({});
  });
});
