import type { ApiClient, Conversation } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthContext } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { createWebPlatform } from "../../../platform";
import { TYPING_THROTTLE_MS, useTypingActivity } from "../../../data/typing";
import {
  broadcastCandidate,
  broadcastMentionFor,
  matchCandidates,
  parseMentions,
  type MentionCandidate,
} from "../../../lib/mentions";
import { serializeMentionDraft } from "../../../lib/mention-draft";
import { ConversationView } from "../ConversationView";

beforeAll(() => {
  class Observer implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = Observer;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const owner = { id: "qa-owner", name: "QA User", email: "fixture@example.invalid", initials: "QU" };

function spiedClient() {
  const base = createMockClient({ seed: 7 });
  const typing = vi.fn(async (_id: string, _active: boolean): Promise<void> => {});
  const client = { ...base, conversations: { ...base.conversations, typing } };
  return { client, typing: typing as Mock };
}

function hookWrapper(client: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const platform = createWebPlatform();
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} platform={platform} queryClient={qc}>
      {children}
    </ClientProvider>
  );
}

describe("typing activity hook", () => {
  it("posts boolean activity immediately and never draft text", () => {
    const { client, typing } = spiedClient();
    const { result } = renderHook(() => useTypingActivity("c-1"), {
      wrapper: hookWrapper(client),
    });
    result.current.reportTyping();
    expect(typing).toHaveBeenCalledTimes(1);
    expect(typing).toHaveBeenCalledWith("c-1", true);
  });

  it("throttles bursts to one per second with a single trailing post", () => {
    const { client, typing } = spiedClient();
    const { result } = renderHook(() => useTypingActivity("c-1"), {
      wrapper: hookWrapper(client),
    });
    result.current.reportTyping();
    result.current.reportTyping();
    result.current.reportTyping();
    expect(typing).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TYPING_THROTTLE_MS);
    expect(typing).toHaveBeenCalledTimes(2);
    expect(typing).toHaveBeenLastCalledWith("c-1", true);
    vi.advanceTimersByTime(TYPING_THROTTLE_MS * 5);
    expect(typing).toHaveBeenCalledTimes(2);
  });

  it("posts false on stop and stays quiet afterwards", () => {
    const { client, typing } = spiedClient();
    const { result } = renderHook(() => useTypingActivity("c-1"), {
      wrapper: hookWrapper(client),
    });
    result.current.reportTyping();
    result.current.stopTyping();
    expect(typing).toHaveBeenLastCalledWith("c-1", false);
    const calls = typing.mock.calls.length;
    vi.advanceTimersByTime(TYPING_THROTTLE_MS * 5);
    expect(typing.mock.calls.length).toBe(calls);
  });

  it("ends the previous chat on switch and never touches the new one", () => {
    const { client, typing } = spiedClient();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useTypingActivity(id), {
      wrapper: hookWrapper(client),
      initialProps: { id: "c-1" },
    });
    result.current.reportTyping();
    rerender({ id: "c-2" });
    expect(typing).toHaveBeenLastCalledWith("c-1", false);
    expect(typing.mock.calls.some((call) => call[0] === "c-2")).toBe(false);
  });

  it("cleans up on unmount with no leaking timers", () => {
    const { client, typing } = spiedClient();
    const { result, unmount } = renderHook(() => useTypingActivity("c-1"), {
      wrapper: hookWrapper(client),
    });
    result.current.reportTyping();
    result.current.reportTyping();
    unmount();
    expect(typing).toHaveBeenLastCalledWith("c-1", false);
    const calls = typing.mock.calls.length;
    vi.advanceTimersByTime(TYPING_THROTTLE_MS * 10);
    expect(typing.mock.calls.length).toBe(calls);
  });

  it("swallows transport failures and keeps working", () => {
    const { client, typing } = spiedClient();
    typing.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useTypingActivity("c-1"), {
      wrapper: hookWrapper(client),
    });
    expect(() => result.current.reportTyping()).not.toThrow();
    vi.advanceTimersByTime(TYPING_THROTTLE_MS);
    result.current.reportTyping();
    expect(typing.mock.calls.length).toBeGreaterThan(1);
  });

  it("stays silent without a conversation id", () => {
    const { client, typing } = spiedClient();
    const { result, unmount } = renderHook(() => useTypingActivity(undefined), {
      wrapper: hookWrapper(client),
    });
    result.current.reportTyping();
    result.current.stopTyping();
    unmount();
    vi.advanceTimersByTime(TYPING_THROTTLE_MS * 5);
    expect(typing).not.toHaveBeenCalled();
  });
});

describe("broadcast mention aliases", () => {
  const members: MentionCandidate[] = [
    { id: "agent-juno", handle: "juno", name: "Juno" },
    { id: "agent-patch", handle: "patch", name: "Patch" },
  ];

  it("resolves every alias to a canonical broadcast mention", () => {
    expect(broadcastMentionFor("all")).toEqual({ kind: "agent", id: "all", label: "@all" });
    expect(broadcastMentionFor("Everyone")).toEqual({
      kind: "agent",
      id: "everyone",
      label: "@everyone",
    });
    expect(broadcastMentionFor("patch")).toBeNull();
    expect(broadcastMentionFor("nobody")).toBeNull();
  });

  it("parses typed aliases to canonical ids without inviting anyone", () => {
    const mentions = parseMentions("@all sync up @everyone", members);
    expect(mentions.map((mention) => mention.id).sort()).toEqual(["all", "everyone"]);
    expect(parseMentions("ping @nobody", members)).toEqual([]);
    expect(parseMentions("ping @patch", members)).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
    expect(parseMentions("`@all` in code", members)).toEqual([]);
  });

  it("shows an All agents row for every alias query", () => {
    const candidates = [...members, broadcastCandidate("All agents")];
    expect(matchCandidates("", candidates)).toHaveLength(3);
    expect(matchCandidates("everyone", candidates).map((row) => row.id)).toEqual(["all"]);
    expect(matchCandidates("a", candidates).map((row) => row.id)).toContain("all");
    expect(matchCandidates("zzz", candidates)).toEqual([]);
  });

  it("serializes a picked All agents span to the canonical mention", () => {
    const candidates = [...members, broadcastCandidate("All agents")];
    // The picker inserts the display name, then tracks the name as a span; the
    // span must still cover that exact text for the canonical handle to win.
    const placed = serializeMentionDraft(
      "All agents ",
      [{ id: "all", name: "All agents", start: 0, end: 10 }],
      candidates,
    );
    expect(placed.mentions).toEqual([{ kind: "agent", id: "all", label: "@all" }]);
    expect(placed.text).toBe("@all");
  });
});

describe("conversation typing integration", () => {
  const at = "2026-10-07T00:00:00Z";
  function direct(): Conversation {
    return {
      id: "c-direct",
      kind: "direct",
      agentIds: ["agent-juno"],
      memberIds: ["qa-owner"],
      unreadCount: 0,
      lastItemAt: at,
      createdAt: at,
    };
  }
  function room(): Conversation {
    return { ...direct(), id: "c-room", kind: "room", agentIds: ["agent-juno", "agent-patch"] };
  }
  async function view(conversation: Conversation, typing: Mock) {
    const base = createMockClient({ seed: 1 });
    const agents = await Promise.all(
      conversation.agentIds.map((id) => base.agents.get(id)),
    );
    const client = { ...base, conversations: { ...base.conversations, typing } };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <AuthContext value={{ mode: "account", user: owner, signOut: () => {} }}>
            <ClientProvider client={client} platform={createWebPlatform()} queryClient={qc}>
              <ConversationView
                conversation={conversation}
                agents={agents}
                primaryAgent={agents[0]}
                items={[]}
                isLoading={false}
                isError={false}
                computerPanelOpen={false}
                onRetry={() => {}}
                onSend={() => {}}
                onToggleComputerPanel={() => {}}
                onOpenCitation={() => {}}
              />
            </ClientProvider>
          </AuthContext>
        </TooltipProvider>
      </ThemeProvider>,
    );
  }

  it("pings boolean activity while typing in a private thread", () => {
    const typing = vi.fn(async (_id: string, _active: boolean): Promise<void> => {});
    return view(direct(), typing).then(() => {
      const box = screen.getByRole("textbox");
      fireEvent.change(box, { target: { value: "hel" } });
      expect(typing).toHaveBeenCalledWith("c-direct", true);
    });
  });

  it("stays silent in rooms with short placeholder", async () => {
    const typing = vi.fn(async (_id: string, _active: boolean): Promise<void> => {});
    await view(room(), typing);
    const box = screen.getByRole("textbox");
    // The product copy for a room composer is intentionally short; only the fixture literal changed.
    expect(box.getAttribute("placeholder") ?? "").toBe("Message…");
    fireEvent.change(box, { target: { value: "hello room" } });
    expect(typing).not.toHaveBeenCalled();
  });

  it("offers All agents from the group mention picker", async () => {
    const typing = vi.fn(async (_id: string, _active: boolean): Promise<void> => {});
    await view(room(), typing);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "@a" } });
    // Fake timers stall testing-library's async waiters, so settle React's
    // state update explicitly instead of racing a timer that never fires.
    await act(async () => {});
    expect(screen.getByText("All agents")).toBeDefined();
  });
});
