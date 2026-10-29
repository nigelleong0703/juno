import type { ApiClient, DocumentDraft, DocumentView, LibraryItem } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { LibraryPage } from "../../../features/library/LibraryPage";
import { createWebPlatform } from "../../../platform";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AT = "2026-10-29T00:00:00.000Z";

interface Setup {
  head?: { version: number; markdown: string };
  draft?: { markdown: string; author: DocumentDraft["author"]; summary?: string; revision?: number };
}

/** A document served from memory: the Library row, `documents.*` as spies, and the state they share. */
async function documentClient(setup: Setup) {
  const base = createMockClient({ seed: 1 });
  const agentId = (await base.agents.list()).items[0]!.id;
  const row = {
    ...(await base.library.get("lib-art-trip")),
    id: "doc-1",
    name: "Trip plan",
    kind: "document",
    render: "doc",
    mimeType: "text/markdown",
    createdByAgentId: agentId,
    version: setup.head?.version,
    versions: undefined,
  } as LibraryItem;
  const state = {
    head: setup.head,
    draft: setup.draft
      ? ({ id: "draft-1", documentId: "doc-1", baseVersion: setup.head?.version ?? 0, revision: setup.draft.revision ?? 1, title: "Trip plan", summary: setup.draft.summary, author: setup.draft.author, sizeBytes: 1, sha256: "x", status: "pending", createdAt: AT, updatedAt: AT } as DocumentDraft)
      : undefined,
    draftText: setup.draft?.markdown ?? "",
  };
  const view = (): DocumentView => ({ document: { ...row, version: state.head?.version }, ...(state.draft ? { draft: state.draft } : {}) });
  const documents = {
    create: vi.fn(),
    conversation: vi.fn(),
    get: vi.fn(async () => view()),
    draft: vi.fn(async () => ({ draft: state.draft as DocumentDraft, markdown: state.draftText })),
    version: vi.fn(async (_id: string, version: number) => ({ version, markdown: state.head?.markdown ?? "", sha256: "x" })),
    saveDraft: vi.fn(async (_id: string, input: { markdown: string }) => {
      state.draft = { ...(state.draft ?? ({ id: "draft-2", documentId: "doc-1", baseVersion: 0, title: "Trip plan", sizeBytes: 1, sha256: "x", status: "pending", createdAt: AT, updatedAt: AT, revision: 0 } as DocumentDraft)), author: "person", revision: (state.draft?.revision ?? 0) + 1 };
      state.draftText = input.markdown;
      return { draft: state.draft, markdown: input.markdown };
    }),
    approve: vi.fn(async () => {
      state.head = { version: (state.head?.version ?? 0) + 1, markdown: state.draftText };
      state.draft = undefined;
      return view();
    }),
    decline: vi.fn(async () => {
      state.draft = undefined;
      return view();
    }),
  };
  const client: ApiClient = {
    ...base,
    library: { ...base.library, get: async () => row, list: async () => ({ items: [row], nextCursor: null }) },
    documents,
  };
  return { client, documents, state, agentName: (await base.agents.list()).items[0]!.name };
}

function open(client: ApiClient): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}>
      <MemoryRouter initialEntries={["/library/doc-1"]}>
        <Routes>
          <Route path="/library/:fileId?" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  );
  return queryClient;
}

const HTML_DOC = "Intro\n\n<div class=\"x\">raw html</div>\n";

describe("document review", () => {
  it("shows the agent's draft, a changes view against the saved version, and approves it with the revision it shows", async () => {
    const setup = await documentClient({
      head: { version: 1, markdown: "# Plan\n\nOld line." },
      draft: { author: { agentId: "agent-x" }, markdown: "# Plan\n\nNew line.", summary: "Reworded the line", revision: 4 },
    });
    open(setup.client);
    expect(await screen.findByText(`${setup.agentName} proposed changes · Reworded the line`)).toBeDefined();
    expect((await screen.findByRole("button", { name: "Approve & save" })).getAttribute("disabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: "Changes" }));
    const changes = await screen.findByRole("list", { name: "Changes" });
    expect(changes.querySelector("[data-change=added]")?.textContent).toContain("New line.");
    expect(changes.querySelector("[data-change=removed]")?.textContent).toContain("Old line.");

    fireEvent.click(screen.getByRole("button", { name: "Approve & save" }));
    await waitFor(() => expect(setup.documents.approve).toHaveBeenCalledWith("doc-1", { draftId: "draft-1", expectedRevision: 4 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve & save" })).toBeNull());
  });

  it("declines the draft", async () => {
    const setup = await documentClient({ head: { version: 1, markdown: "# Plan" }, draft: { author: { agentId: "agent-x" }, markdown: "# Plan\n\nMore." } });
    open(setup.client);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() => expect(setup.documents.decline).toHaveBeenCalledWith("doc-1", { draftId: "draft-1", expectedRevision: 1 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Decline" })).toBeNull());
  });

  it("shows the server's message when approval cannot be written to the external app, and keeps the draft", async () => {
    const setup = await documentClient({ draft: { author: { agentId: "agent-x" }, markdown: "# Fresh" } });
    setup.documents.approve.mockRejectedValue(Object.assign(new Error("Writing to Google Docs is not available yet."), { status: 501, code: "EXTERNAL_TARGET_UNAVAILABLE" }));
    open(setup.client);
    // The button is disabled until the draft's Markdown has loaded.
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve & save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Approve & save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Writing to Google Docs is not available yet.");
    expect(screen.getByRole("button", { name: "Approve & save" })).toBeDefined();
  });

  it("follows a draft the agent replaces while nothing is being edited", async () => {
    const setup = await documentClient({ draft: { author: { agentId: "agent-x" }, markdown: HTML_DOC, summary: "First" } });
    const queryClient = open(setup.client);
    const field = (await screen.findByLabelText("Document Markdown")) as HTMLTextAreaElement;
    expect(field.value).toBe(HTML_DOC);
    setup.state.draft = { ...setup.state.draft!, revision: 2, summary: "Second" };
    setup.state.draftText = `${HTML_DOC}\nMore.\n`;
    applyEvent(queryClient, { type: "document.draft.updated", draft: setup.state.draft });
    await waitFor(() => expect(((screen.getByLabelText("Document Markdown")) as HTMLTextAreaElement).value).toBe(`${HTML_DOC}\nMore.\n`));
  });
});

describe("document editing", () => {
  it("opens Markdown the rich editor would lose in source mode, autosaves it against the loaded revision, and keeps the text on a conflict", async () => {
    const setup = await documentClient({ draft: { author: { agentId: "agent-x" }, markdown: HTML_DOC, revision: 3 } });
    open(setup.client);
    const field = (await screen.findByLabelText("Document Markdown")) as HTMLTextAreaElement;
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).toBeNull();

    fireEvent.change(field, { target: { value: `${HTML_DOC}\nEdited.\n` } });
    await waitFor(() => expect(setup.documents.saveDraft).toHaveBeenCalledWith("doc-1", { title: "Trip plan", markdown: `${HTML_DOC}\nEdited.\n`, expectedRevision: 3 }), { timeout: 3000 });
    // Once the person has edited it, the draft is theirs to save, not an agent proposal to approve.
    expect(await screen.findByRole("button", { name: "Save" })).toBeDefined();

    setup.documents.saveDraft.mockRejectedValue(Object.assign(new Error("changed"), { status: 409, code: "DOCUMENT_DRAFT_CHANGED" }));
    fireEvent.change(screen.getByLabelText("Document Markdown"), { target: { value: `${HTML_DOC}\nEdited again.\n` } });
    expect(await screen.findByText("Changed elsewhere — reload", undefined, { timeout: 3000 })).toBeDefined();
    expect((screen.getByLabelText("Document Markdown") as HTMLTextAreaElement).value).toBe(`${HTML_DOC}\nEdited again.\n`);

    // Reload takes what the server holds and drops the local text.
    setup.state.draftText = "Server text <b>bold</b>";
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect((screen.getByLabelText("Document Markdown") as HTMLTextAreaElement).value).toBe("Server text <b>bold</b>"));
    expect(screen.queryByText("Changed elsewhere — reload")).toBeNull();
  });

  it("saves the person's own edit on a saved document as the next version", async () => {
    const setup = await documentClient({ head: { version: 2, markdown: HTML_DOC } });
    open(setup.client);
    const field = (await screen.findByLabelText("Document Markdown")) as HTMLTextAreaElement;
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(field, { target: { value: `${HTML_DOC}\nMine.\n` } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    // Save flushes the autosave first (no draft open: against the saved head), then approves what that created.
    await waitFor(() => expect(setup.documents.saveDraft).toHaveBeenCalledWith("doc-1", { title: "Trip plan", markdown: `${HTML_DOC}\nMine.\n`, baseVersion: 2 }));
    await waitFor(() => expect(setup.documents.approve).toHaveBeenCalledWith("doc-1", { draftId: "draft-2", expectedRevision: 1 }));
  });
});
