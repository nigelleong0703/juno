import { aguiInput } from '../../agui-input.js';
import { describe, expect, it, vi } from 'vitest';
import { createAccount, docRowsContaining, listenEvents, scriptModel, waitForIdle, waitForToolActivity, toolCall, type ScriptedTurn } from '../harness/client';

const WAIT_MS = 90_000;
vi.setConfig({ testTimeout: 240_000 });

/**
 * Documents (BACKEND 5.11a): the agent drafts, the owner reviews. document_create makes a document with a pending draft; the owner's
 * approve makes version 1 and wakes the agent (no run waited); the agent reads, proposes version 2 (a repeated call is the same draft,
 * a stale base is refused); the owner edits the draft, which locks agents out until they decide; their save is version 2. Text lives in the
 * blob store only.
 */
const V1 = '# Trip plan\n\nPack socks.\n';
const V2 = '# Trip plan\n\nPack socks.\nBook the train.\n';
const OWNER_EDIT = '# Trip plan\n\nPack socks. Pack a hat.\n';
const V3 = '# Trip plan\n\nPack socks. Pack a hat.\nBook the train.\n';

const doc = (id: string, name: string, args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [toolCall(id, name, args)] });

describe('documents', () => {
  it('draft -> approve -> read -> propose (retry-safe, stale base refused) -> owner edit -> approve', async () => {
    const alice = await createAccount('doc-alice');
    const bob = await createAccount('doc-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Writer' });
    expect(agent.status).toBe(201);
    const events = await listenEvents(alice.cookie);
    try {
      const created = await alice.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      const run = (text: string) => alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
      const results = async (name: string, count: number) => (await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === name).length >= count, WAIT_MS)).results.filter((r) => r.toolName === name);

      // One script for the whole conversation: a turn is picked by the number of model calls so far, and the owner's decisions wake the agent in between.
      // The document id is not known before the first call, so the rest of the script is written once it is (below).
      scriptModel(sessionKey, [doc('c1', 'document_create', { title: 'Trip plan', markdown: V1 }), { text: 'drafted' }]);
      expect((await run('write me a trip plan')).status).toBe(202);
      const first = await results('document_create', 1);
      expect(first[0]?.isError).toBe(false);
      await waitForIdle(events, conversationId);

      // The card in the chat, the pending draft, no saved version, and nothing in memory yet.
      const cards = ((await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<Record<string, any>>).filter((item) => item.type === 'artifact');
      expect(cards).toHaveLength(1);
      const documentId = cards[0]!.artifactId as string;
      const view = await alice.api('GET', `/v1/documents/${documentId}`);
      expect(view.status).toBe(200);
      expect(view.body.document).toMatchObject({ id: documentId, name: 'Trip plan', render: 'doc', kind: 'document', mimeType: 'text/markdown' });
      expect(view.body.document.version).toBeUndefined();
      expect(view.body.draft).toMatchObject({ status: 'pending', baseVersion: 0, revision: 1, author: { agentId: agent.body.id } });
      expect((await alice.api('GET', `/v1/documents/${documentId}/draft`)).body.markdown).toBe(V1);
      expect((await bob.api('GET', `/v1/documents/${documentId}`)).status).toBe(404);
      expect((await bob.api('GET', `/v1/documents/${documentId}/draft`)).status).toBe(404);
      expect((await bob.api('POST', `/v1/documents/${documentId}/draft/approve`, { draftId: view.body.draft.id, expectedRevision: 1 })).status).toBe(404);
      expect((await alice.api('GET', `/v1/library/${documentId}`)).body).toMatchObject({ render: 'doc' });
      const pendingLines = ((await alice.api('GET', '/v1/memory/items?limit=100')).body.items as Array<{ text: string }>).filter((item) => item.text.includes(documentId));
      expect(pendingLines).toHaveLength(0);

      // ---- the owner approves: version 1, the agent is woken (no run was waiting) and the script continues with this id.
      scriptModel(sessionKey, [
        ...Array.from({ length: 2 }, () => ({ text: '.' })),
        doc('r1', 'document_read', { documentId }),
        doc('p1', 'document_propose', { documentId, baseVersion: 1, markdown: V2, summary: 'Added the train' }),
        doc('p1', 'document_propose', { documentId, baseVersion: 1, markdown: V2, summary: 'Added the train' }),
        doc('p2', 'document_propose', { documentId, baseVersion: 0, markdown: 'stale', summary: 'old base' }),
        { text: 'proposed' },
        doc('p3', 'document_propose', { documentId, baseVersion: 1, markdown: 'overwrite', summary: 'again' }),
        { text: 'will ask first' },
        doc('r2', 'document_read', { documentId }),
        { text: 'noted' },
      ]);
      const approved = await alice.api('POST', `/v1/documents/${documentId}/draft/approve`, { draftId: view.body.draft.id, expectedRevision: 1 });
      expect(approved.status).toBe(200);
      expect(approved.body.draft).toMatchObject({ status: 'approved', savedVersion: 1 });
      // Approving again is the same version, not a second one.
      const again = await alice.api('POST', `/v1/documents/${documentId}/draft/approve`, { draftId: view.body.draft.id, expectedRevision: 1 });
      expect(again.body.draft.savedVersion).toBe(1);
      await events.waitFor((e) => e.data.type === 'artifact.updated' && e.data.artifact.id === documentId && e.data.artifact.version === 1);
      await events.waitFor((e) => e.data.type === 'document.draft.updated' && e.data.draft.id === view.body.draft.id && e.data.draft.status === 'approved');
      expect((await alice.api('GET', `/v1/documents/${documentId}/versions/1/content`)).body).toMatchObject({ version: 1, markdown: V1 });
      const remembered = ((await alice.api('GET', '/v1/memory/items?limit=100')).body.items as Array<{ text: string }>).filter((item) => item.text.includes(`artifactId ${documentId},`));
      expect(remembered).toHaveLength(1);
      expect(remembered[0]?.text).toContain('Saved the document "Trip plan" (version 1)');

      // ---- the woken agent reads the saved head, proposes version 2 (the repeated call is the same draft), and a stale base is refused.
      const read = (await results('document_read', 1))[0]!;
      expect(read.isError).toBe(false);
      expect(read.text).toContain('Saved head: version 1');
      expect(read.text).toContain('Pack socks.');
      const proposals = await results('document_propose', 3);
      expect(proposals.map((r) => r.isError)).toEqual([false, false, true]);
      expect(proposals[1]?.text).toContain('already saved');
      expect(proposals[2]?.text).toContain('document_read');
      await waitForIdle(events, conversationId);
      const open = await alice.api('GET', `/v1/documents/${documentId}`);
      expect(open.body.draft).toMatchObject({ status: 'pending', baseVersion: 1, author: { agentId: agent.body.id }, summary: 'Added the train' });
      const pendingDrafts = open.body.draft.id;

      // ---- the owner edits the agent's draft; an agent that proposes again is told to ask instead of overwriting it.
      const stale = await alice.api('PUT', `/v1/documents/${documentId}/draft`, { title: 'Trip plan', markdown: OWNER_EDIT, expectedRevision: 9 });
      expect(stale.status).toBe(409);
      const edited = await alice.api('PUT', `/v1/documents/${documentId}/draft`, { title: 'Trip plan', markdown: OWNER_EDIT, expectedRevision: 1 });
      expect(edited.status).toBe(200);
      expect(edited.body.draft).toMatchObject({ id: pendingDrafts, author: 'person', revision: 2 });
      expect((await run('add something else')).status).toBe(202);
      const refused = (await results('document_propose', 4))[3]!;
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('editing');
      await waitForIdle(events, conversationId);
      expect((await alice.api('GET', `/v1/documents/${documentId}/draft`)).body).toMatchObject({ markdown: OWNER_EDIT, draft: { author: 'person', revision: 2 } });

      // ---- the owner saves: version 2 is their text; the agent is told and reads it.
      const saved = await alice.api('POST', `/v1/documents/${documentId}/draft/approve`, { draftId: pendingDrafts, expectedRevision: 2 });
      expect(saved.body.draft).toMatchObject({ status: 'approved', savedVersion: 2 });
      expect((await alice.api('GET', `/v1/documents/${documentId}`)).body.document).toMatchObject({ version: 2 });
      expect((await alice.api('GET', `/v1/documents/${documentId}/versions/2/content`)).body.markdown).toBe(OWNER_EDIT);
      expect((await alice.api('GET', `/v1/documents/${documentId}/versions/1/content`)).body.markdown).toBe(V1);
      const reread = (await results('document_read', 2))[1]!;
      expect(reread.text).toContain('Saved head: version 2');
      expect(reread.text).toContain('Pack a hat.');

      // ---- a person-made document, and the chat about it with this agent (the same chat every time).
      const own = await alice.api('POST', '/v1/documents', { title: 'Notes', markdown: 'mine' });
      expect(own.status).toBe(201);
      expect((await alice.api('POST', `/v1/documents/${own.body.document.id}/draft/approve`, { draftId: own.body.draft.id, expectedRevision: 1 })).body.draft.savedVersion).toBe(1);
      const chat = await alice.api('POST', `/v1/documents/${documentId}/conversations`, { agentId: agent.body.id });
      expect(chat.body).toMatchObject({ documentId });
      expect((await alice.api('POST', `/v1/documents/${documentId}/conversations`, { agentId: agent.body.id })).body.id).toBe(chat.body.id);

      // ---- deleting the document removes its drafts; the text was never in a Postgres document.
      for (const body of [V1, V2, OWNER_EDIT, V3]) {
        for (const needle of [body.split('\n')[2] ?? body, Buffer.from(body).toString('base64').slice(0, 40)]) {
          for (const table of ['library', 'artifact_files', 'document_drafts', 'items', 'transcripts'] as const) {
            if (table === 'transcripts') continue; // the model was shown the text in tool results; transcripts are the model's record, not the document store
            expect(await docRowsContaining(table, needle)).toBe(0);
          }
        }
      }
      expect((await alice.api('DELETE', `/v1/library/${documentId}`)).status).toBe(200);
      expect((await alice.api('GET', `/v1/documents/${documentId}`)).status).toBe(404);
      expect(await docRowsContaining('document_drafts', pendingDrafts)).toBe(0);
    } finally {
      events.close();
    }
  });
});
