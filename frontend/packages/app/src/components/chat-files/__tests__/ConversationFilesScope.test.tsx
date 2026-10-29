import type { ApiClient, Conversation, LibraryItem } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { createWebPlatform } from "../../../platform";
import { ConversationFilesPanel } from "../ConversationFilesPanel";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function fixture(kind: Conversation["kind"]) {
  const base = createMockClient({ seed: 1 });
  const agents = (await base.agents.list()).items;
  const member = agents[0];
  const unrelated = agents[1];
  const original = (await base.conversations.list()).items[0];
  const file = (await base.library.list()).items[0];
  if (!member || !unrelated || !original || !file) throw new Error("Missing fixture");
  const chat: Conversation = { ...original, id: "scope-one", kind, agentIds: [member.id] };
  const second: Conversation = { ...chat, id: "scope-two" };
  const files: LibraryItem[] = [
    { ...file, id: "file-one", name: "first.md", conversationId: chat.id, createdByAgentId: member.id },
    { ...file, id: "file-two", name: "second.md", conversationId: second.id, createdByAgentId: unrelated.id },
  ];
  const client: ApiClient = {
    ...base,
    conversations: { ...base.conversations, get: async (id) => id === chat.id ? chat : second },
    library: { ...base.library, list: async () => ({ items: files, nextCursor: null }) },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}><MemoryRouter>{children}</MemoryRouter></ClientProvider>;
  }
  return { chat, second, member, unrelated, queryClient, Wrapper };
}
it("private chat hides agent filter", async () => {
  const f = await fixture("direct");
  render(<ConversationFilesPanel conversationId={f.chat.id} />, { wrapper: f.Wrapper });
  expect(await screen.findByText("first.md")).toBeDefined();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText("second.md")).toBeNull();
});
it("group chat excludes unrelated agents", async () => {
  const f = await fixture("room");
  render(<ConversationFilesPanel conversationId={f.chat.id} />, { wrapper: f.Wrapper });
  fireEvent.click(await screen.findByRole("combobox"));
  expect(await screen.findByRole("option", { name: f.member.name })).toBeDefined();
  expect(screen.queryByRole("option", { name: f.unrelated.name })).toBeNull();
});
it("switching chats clears stale agent filter", async () => {
  const f = await fixture("room");
  const view = render(<ConversationFilesPanel conversationId={f.chat.id} />, { wrapper: f.Wrapper });
  fireEvent.click(await screen.findByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: f.member.name }));
  await waitFor(() => expect(screen.getByRole("combobox").textContent).toContain(f.member.name));
  view.rerender(<ConversationFilesPanel conversationId={f.second.id} />);
  expect(await screen.findByText("second.md")).toBeDefined();
  await waitFor(() => expect(screen.getByRole("combobox").textContent).toContain("Every agent"));
  expect(screen.queryByText("first.md")).toBeNull();
});
