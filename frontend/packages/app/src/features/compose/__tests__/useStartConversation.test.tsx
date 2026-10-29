import type { CreateConversationInput } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import type { ComposeRecipient } from "../../../store/ui";
import { useStartConversation } from "../useStartConversation";
import type { ReactNode } from "react";

type CapturedBody = CreateConversationInput;

// Vitest runs without globals, so Testing Library's automatic cleanup is not registered. Track
// every QueryClient this file creates and dispose both React and the query work in afterEach.
const clients: QueryClient[] = [];

function setup(convFailures: number, opts?: { hideDirects?: boolean }) {
  const base = createMockClient({ seed: 7 });
  const bodies: CapturedBody[] = [];
  const agentNames: (string | undefined)[] = [];
  const sends: { id: string; text: string; attachments: number; mentions: number }[] = [];
  let remaining = convFailures;
  const client: MockClient = {
    ...base,
    agents: {
      ...base.agents,
      create: async (input) => {
        agentNames.push(input.name);
        return base.agents.create(input);
      },
    },
    conversations: {
      ...base.conversations,
      send: async (id, payload) => {
        sends.push({
          id,
          text: payload.text,
          attachments: payload.attachments?.length ?? 0,
          mentions: payload.mentions?.length ?? 0,
        });
        return base.conversations.send(id, payload);
      },
      // The live API starts a fresh agent with no threads; the mock seeds a
      // direct inside agents.create. Hiding it reproduces the real absent
      // query so the create path (not the seeded shortcut) is exercised.
      ...(opts?.hideDirects
        ? { list: async () => ({ items: [], nextCursor: null }) }
        : {}),
      create: async (input) => {
        bodies.push({ ...input });
        if (remaining > 0) {
          remaining -= 1;
          throw new Error("conversation failed");
        }
        return base.conversations.create(input);
      },
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient}>
      {children}
    </ClientProvider>
  );
  return { base, bodies, agentNames, sends, wrapper };
}

afterEach(() => {
  // Unmount the hook first, then cancel/clear the owned caches so no observer, scheduler callback
  // or pending mutation settles against a torn-down `window`.
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

const draft = (text: string, recipients?: ComposeRecipient[]) => {
  const to: ComposeRecipient[] = recipients ?? [{ key: "new-1", kind: "new", name: "Juno" }];
  return { recipients: to, payload: { text } };
};

function requestIdOf(body: CapturedBody | undefined): string {
  if (!body?.requestId) throw new Error("missing requestId");
  return body.requestId;
}

describe("useStartConversation idempotency", () => {
  it("retries the same intent with a stable requestId", async () => {
    const { bodies, wrapper } = setup(1, { hideDirects: true });
    const { result } = renderHook(() => useStartConversation(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(draft("hello")).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(draft("hello"));
    });
    expect(bodies).toHaveLength(2);
    expect(requestIdOf(bodies[0])).toBe(requestIdOf(bodies[1]));
  });

  it("uses a new requestId once the intent is edited", async () => {
    const { bodies, wrapper } = setup(2, { hideDirects: true });
    const { result } = renderHook(() => useStartConversation(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(draft("first")).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(draft("second")).catch(() => undefined);
    });
    expect(bodies).toHaveLength(2);
    expect(requestIdOf(bodies[0])).not.toBe(requestIdOf(bodies[1]));
  });

  it("reuses the staged agent on retry instead of creating a duplicate", async () => {
    const { bodies, agentNames, wrapper } = setup(1, { hideDirects: true });
    const { result } = renderHook(() => useStartConversation(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(draft("hello")).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(draft("hello"));
    });
    expect(bodies).toHaveLength(2);
    expect(agentNames).toEqual(["Juno"]);
    expect(requestIdOf(bodies[0])).toBe(requestIdOf(bodies[1]));
  });

  it("opens user rooms on mention with member names in the title", async () => {
    const { bodies, wrapper } = setup(0);
    const { result } = renderHook(() => useStartConversation(), { wrapper });
    const recipients: ComposeRecipient[] = [
      { key: "new-1", kind: "new", name: "Nova" },
      { key: "new-2", kind: "new", name: "Milo" },
    ];
    await act(async () => {
      await result.current.mutateAsync(draft("kickoff", recipients));
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.kind).toBe("room");
    expect(bodies[0]?.firstMessage).toMatchObject({ text: "kickoff" });
    const title = bodies[0]?.title ?? "";
    expect(title).toContain("Nova");
    expect(title).toContain("Milo");
    const room = bodies[0];
    expect(room !== undefined && "roomMode" in room && room.roomMode).toBe("mention");
  });

  it("sends into the existing 1:1 instead of creating a duplicate", async () => {
    const { base, bodies, sends, wrapper } = setup(0);
    const agent = await base.agents.create({ name: "Ava" });
    const { result } = renderHook(() => useStartConversation(), { wrapper });
    const recipients: ComposeRecipient[] = [
      { key: agent.id, kind: "agent", agentId: agent.id, name: agent.name },
    ];
    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync({
        recipients,
        payload: {
          text: "hello again",
          attachments: [
            { id: "a1", name: "plan.png", kind: "image", mimeType: "image/png", sizeBytes: 12 },
          ],
          mentions: [{ kind: "agent", id: agent.id, label: "@ava" }],
        },
      });
    });
    expect(bodies).toHaveLength(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ text: "hello again", attachments: 1, mentions: 1 });
    expect(typeof returned).toBe("string");
  });
});
