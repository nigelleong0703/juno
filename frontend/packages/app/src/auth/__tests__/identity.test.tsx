import type { ApiClient, Item, Request, ResolveRequestInput } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, usePeople, type AuthIdentity } from "../AuthContext";
import { UserMessage } from "../../components/conversation/UserMessage";
import { MembersPanel } from "../../components/computer/panels/MembersPanel";
import { ClientProvider } from "../../data/ClientProvider";
import { useResolveRequest, useSendMessage } from "../../data/mutations";
import { qk } from "../../data/keys";
import { webPlatform } from "../../platform";
import { AppRail } from "../../shell/AppRail";

const identity: AuthIdentity = { mode: "account", user: { id: "alice-owner", name: "Alice Chen", email: "alice@example.com", initials: "AC" }, signOut: vi.fn() };
afterEach(cleanup);
function wrapperFor(client: ApiClient, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <AuthContext value={identity}><ClientProvider client={client} platform={webPlatform} queryClient={queryClient}>{children}</ClientProvider></AuthContext>;
}

describe("account identity consumers", () => {
  it("uses the actual rail identity and account menu sign-out action", async () => {
    const client = createMockClient({ seed: 5 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<AuthContext value={identity}><ThemeProvider><TooltipProvider><ClientProvider client={client} platform={webPlatform} queryClient={qc}><MemoryRouter><AppRail /></MemoryRouter></ClientProvider></TooltipProvider></ThemeProvider></AuthContext>);
    const footer = screen.getByRole("button", { name: "Alice Chen" });
    expect(screen.queryByRole("button", { name: "Robin" })).toBeNull();
    fireEvent.keyDown(footer, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(identity.signOut).toHaveBeenCalledOnce();
    qc.clear();
  });

  it("labels current group members as You, without assigning mock names to account members", () => {
    render(<AuthContext value={identity}><MembersPanel agents={[]} memberIds={["alice-owner", "member-robin"]} /></AuthContext>);
    expect(screen.getByText("You")).toBeDefined();
    expect(screen.getByText("member-robin")).toBeDefined();
    expect(screen.queryByText("Robin")).toBeNull();
  });

  it("identifies own messages and keeps other users distinct", () => {
    const item: Extract<Item, { type: "user_message" }> = { type: "user_message", id: "item", authorId: "alice-owner", conversationId: "chat", at: new Date().toISOString(), text: "Own message", attachments: [], mentions: [] };
    const view = render(<AuthContext value={identity}><UserMessage item={item} /></AuthContext>);
    expect(screen.queryByText("Alice Chen")).toBeNull();
    view.rerender(<AuthContext value={identity}><UserMessage item={{ ...item, authorId: "member-robin" }} /></AuthContext>);
    expect(screen.getByText("member-robin")).toBeDefined();
  });

  it("draws a platform stranger as an incoming bubble on the left, the owner's own on the right", () => {
    const item: Extract<Item, { type: "user_message" }> = { type: "user_message", id: "item", authorId: "alice-owner", conversationId: "chat", at: new Date().toISOString(), text: "Hi from Discord", attachments: [], mentions: [] };
    const sender = { kind: "discord", externalId: "1", name: "Mia" } as never;
    // A stranger's author is a synthetic id (the owner's id only when the owner spoke): the name comes from channelSender.
    const strangerItem = { ...item, authorId: "ext-discord-0123456789abcdef", channelSender: { ...(sender as object), role: "stranger" } as never };
    const view = render(<AuthContext value={identity}><UserMessage item={strangerItem} /></AuthContext>);
    expect(screen.getByText("Mia")).toBeDefined();
    expect(screen.queryByText("ext-discord-0123456789abcdef")).toBeNull();
    expect(view.container.querySelector(".is-assistant")).not.toBeNull();
    expect(view.container.querySelector(".is-user")).toBeNull();
    view.rerender(<AuthContext value={identity}><UserMessage item={{ ...item, channelSender: { ...(sender as object), role: "owner" } as never }} /></AuthContext>);
    expect(view.container.querySelector(".is-user")).not.toBeNull();
  });

  it("keeps stable ids and no self outside an account context", () => {
    const { result } = renderHook(() => usePeople());
    expect(result.current.isSelf("member-robin")).toBe(false);
    expect(result.current.memberName("member-robin")).toBe("member-robin");
    expect(result.current.memberName(undefined)).toBe("Unknown");
  });

  it("resolves the owner display name from the injected identity, not a built-in alias", () => {
    const fixture: AuthIdentity = {
      mode: "account",
      user: { id: "member-robin", name: "Robin", email: "robin@example.com", initials: "R" },
      signOut: vi.fn(),
    };
    const { result } = renderHook(() => usePeople(), {
      wrapper: ({ children }: { children: ReactNode }) => <AuthContext value={fixture}>{children}</AuthContext>,
    });
    expect(result.current.isSelf("member-robin")).toBe(true);
    expect(result.current.memberName("member-robin")).toBe("Robin");
  });

  it("attributes optimistic messages to the authenticated owner", async () => {
    const base = createMockClient({ seed: 1 });
    const send = vi.fn<ApiClient["conversations"]["send"]>(() => new Promise(() => {}));
    const client = { ...base, conversations: { ...base.conversations, send } };
    const qc = new QueryClient();
    const { result } = renderHook(() => useSendMessage("chat"), { wrapper: wrapperFor(client, qc) });
    act(() => result.current.mutate({ text: "hello" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(qc.getQueryData<Item[]>(qk.items("chat"))?.[0]).toMatchObject({ authorId: "alice-owner", text: "hello" });
    qc.clear();
  });

  it("ignores spoofed decision.by optimistically and excludes it from the API request", async () => {
    const base = createMockClient({ seed: 1 });
    const pending = (await base.requests.list({ status: "pending" })).items[0];
    if (!pending) throw new Error("Fixture needs a pending request");
    let release: (value: Request) => void = () => {};
    const gate = new Promise<Request>((accept) => { release = accept; });
    const resolve = vi.fn<ApiClient["requests"]["resolve"]>(() => gate);
    const client = { ...base, requests: { ...base.requests, resolve } };
    const qc = new QueryClient(); qc.setQueryData(qk.request(pending.id), pending);
    const { result } = renderHook(() => useResolveRequest(), { wrapper: wrapperFor(client, qc) });
    const decision: ResolveRequestInput = { action: "approve", by: "someone-else", editedDraft: "retain draft" };
    act(() => result.current.mutate({ id: pending.id, decision }));
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    expect(resolve.mock.calls[0]?.[1]).not.toHaveProperty("by");
    expect(resolve.mock.calls[0]?.[1].editedDraft).toBe("retain draft");
    const cached = qc.getQueryData<Request>(qk.request(pending.id));
    expect(cached?.status).toBe("pending");
    expect(cached?.decision).toBeUndefined();
    const authoritative: Request = {
      ...pending,
      status: "approved",
      resolvedAt: new Date().toISOString(),
      decision: { by: "alice-owner", at: new Date().toISOString(), mode: "manual", scope: "once" },
    };
    await act(async () => { release(authoritative); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData<Request>(qk.request(pending.id))?.decision?.by).toBe("alice-owner");
    qc.clear();
  });
});
