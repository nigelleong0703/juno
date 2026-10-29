/**
 * The `## Published in this chat` section: every artifact this agent published in the conversation, with the
 * artifactId and file to pass to artifact_publish for a new version. Built from the library rows, so it
 * survives compaction (a compaction resets the delivered baseline and the next build re-sends it). It is a
 * normal context section: a new publish or version changes its text and appends one `<context_update>`.
 *
 * A chat about a document (`Conversation.documentId`, BACKEND 5.11a) also carries `## This document` in this section: the id,
 * title, saved head version and the state of the open draft, never the text (the agent reads it with document_read).
 * A draft decision or the owner's save changes that text, so the next turn gets one update.
 */
import type { Store } from '../../contracts/index.js';
import { harnessText } from '../../modules/harness/loader.js';

const MAX_LISTED = 20;

async function buildDocumentSection(store: Store, agentId: string, conversationId: string): Promise<string> {
  const conversation = await store.get('conversations', conversationId);
  if (conversation?.documentId === undefined) return '';
  const doc = await store.get('library', conversation.documentId);
  if (doc === null || doc.render !== 'doc') return '';
  const open = (await store.list('documentDrafts', { where: { parentId: doc.id, status: 'pending' }, limit: 1 })).items[0];
  const head = doc.version === undefined ? 'no saved version yet' : 'saved version ' + String(doc.version);
  const who = (author: NonNullable<typeof open>['author']): string => (author === 'person' ? 'the owner' : author.agentId === agentId ? 'you' : 'another agent');
  const draft = open === undefined
    ? 'no open draft'
    : 'open draft by ' + who(open.author) + ' (revision ' + String(open.revision) + ', based on ' + (open.baseVersion === 0 ? 'no saved version' : 'version ' + String(open.baseVersion)) + '), waiting for the owner' + (open.author === 'person' ? ' to save or discard it' : "'s review");
  const target = doc.target === undefined ? '' : '\n- Also lives in ' + doc.target.appId + ' (' + doc.target.url + ')';
  return '## This document\n- ' + JSON.stringify(doc.name) + ' (documentId ' + doc.id + ', ' + head + ')\n- ' + draft + target + '\n' + harnessText('artifacts.document');
}

export async function buildArtifactsSection(store: Store, agentId: string, conversationId: string): Promise<string> {
  const page = await store.list('library', { where: { conversationId }, orderBy: 'at', order: 'desc', limit: 100 });
  // A document is not a file to edit and publish again: it has its own tools and its own section.
  const mine = page.items
    .filter((row) => row.render !== undefined && row.render !== 'doc' && row.createdByAgentId === agentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_LISTED);
  const document = await buildDocumentSection(store, agentId, conversationId);
  if (mine.length === 0) return document;
  const lines = mine.map((row) => '- ' + JSON.stringify(row.name) + ' (artifactId ' + row.id + (row.sourcePath === undefined ? '' : ', ' + row.sourcePath) + ', v' + String(row.version ?? 1) + ')');
  const published = '## Published in this chat\n' + lines.join('\n') + '\n' + harnessText('artifacts.tail');
  return document === '' ? published : document + '\n\n' + published;
}
