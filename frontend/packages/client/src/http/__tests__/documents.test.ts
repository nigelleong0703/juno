import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const ARTIFACT = {
  id: "doc-1",
  name: "Trip plan",
  kind: "document",
  render: "doc",
  mimeType: "text/markdown",
  sizeBytes: 120,
  shared: "private",
  source: "agent",
  tags: [],
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};
const DRAFT = {
  id: "draft-1",
  documentId: "doc-1",
  baseVersion: 2,
  revision: 3,
  title: "Trip plan",
  author: { agentId: "agent-a" },
  sizeBytes: 12,
  sha256: "abc",
  status: "pending",
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

function clientReturning(payload: unknown, status = 200) {
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  );
  const client = createHttpClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch });
  return { client, fetch };
}

function sent(fetch: ReturnType<typeof clientReturning>["fetch"]) {
  const [url, init] = fetch.mock.calls[0] ?? [];
  return { path: new URL(String(url)).pathname, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

describe("documents API", () => {
  it("reads a document with its open draft", async () => {
    const { client, fetch } = clientReturning({ document: ARTIFACT, draft: DRAFT });
    const view = await client.documents.get("doc-1");
    expect(view.draft?.revision).toBe(3);
    expect(sent(fetch)).toMatchObject({ path: "/v1/documents/doc-1", method: "GET" });
  });

  it("saves a draft with the revision the editor loaded", async () => {
    const { client, fetch } = clientReturning({ draft: { ...DRAFT, revision: 4, author: "person" }, markdown: "# Edited" });
    const saved = await client.documents.saveDraft("doc-1", { title: "Trip plan", markdown: "# Edited", expectedRevision: 3 });
    expect(saved.draft.revision).toBe(4);
    expect(sent(fetch)).toMatchObject({ path: "/v1/documents/doc-1/draft", method: "PUT", body: { markdown: "# Edited", expectedRevision: 3 } });
  });

  it("surfaces a stale revision as a 409 the editor can recognise", async () => {
    const { client } = clientReturning({ error: { code: "DOCUMENT_DRAFT_STALE", message: "Changed elsewhere" } }, 409);
    await expect(client.documents.saveDraft("doc-1", { title: "t", markdown: "x", expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("approves and declines by draft id and revision", async () => {
    const approved = clientReturning({ document: { ...ARTIFACT, version: 3 } });
    await approved.client.documents.approve("doc-1", { draftId: "draft-1", expectedRevision: 3 });
    expect(sent(approved.fetch)).toMatchObject({ path: "/v1/documents/doc-1/draft/approve", method: "POST", body: { draftId: "draft-1", expectedRevision: 3 } });
    const declined = clientReturning({ document: ARTIFACT });
    await declined.client.documents.decline("doc-1", { draftId: "draft-1", expectedRevision: 3 });
    expect(sent(declined.fetch)).toMatchObject({ path: "/v1/documents/doc-1/draft/decline", method: "POST" });
  });

  it("reads the Markdown of a saved version", async () => {
    const { client, fetch } = clientReturning({ version: 2, markdown: "# Two", sha256: "x" });
    expect((await client.documents.version("doc-1", 2)).markdown).toBe("# Two");
    expect(sent(fetch).path).toBe("/v1/documents/doc-1/versions/2/content");
  });
});
