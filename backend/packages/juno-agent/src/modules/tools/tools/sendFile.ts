 /**
  * send_file: save a real file from this agent's bound sandbox into the
  * owner's library and announce it in the current conversation.
  *
  * The bytes travel sandbox -> blob store (named by an owner-scoped library row) without ever entering
  * the model context: the tool reads them through one bounded python3 call,
  * validates size and hash locally, stores the bytes in the blob store, and returns
  * only metadata (name, byte count, mime type) to the model. List and get
  * metadata never carry bytes; bytes leave only through the owner-scoped
  * download endpoint. There is no preview URL, token, or data URL anywhere.
  *
  * replay is never: the sandbox read plus the library write are committed
  * side effects, so a crash mid-call must surface as interrupted, never
  * silently re-execute. Membership is revalidated at execution time: the
  * current conversation must list both
  * the agent and the owner, otherwise the tool fails before any sandbox
  * read or store write. Relative paths resolve against the run environment.
  */
import { posix } from 'node:path';
import { z } from 'zod';
import { saveBlob, type LibraryDocument, type Store, type Tool, type ToolContext, type ToolResult } from '../../../contracts/index.js';
import { computerFailure } from '../computer/shared.js';
import { newId, nowIso } from '../util.js';
import { requireRequesterContext } from './relationPolicy.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { chatCapabilities, imageSize, type ChannelOrigin } from '@agent-desktop/public-contracts';
import { errorResult, invalidPath, readSandboxFile, resolveToolPath, throwIfAborted, validateCurrentConversation, type SandboxOpts } from './sandboxFile.js';
import { channelGrants, replyOriginOf } from '../../channel-origin.js';
import type { ChannelPort } from './channelHistory.js';

const sendFileSchema = z.object({
   path: z.string().min(1),
   name: z.string().min(1).optional(),
   mimeType: z.string().min(1).optional(),
 });

/**
 * In a platform chat the file also goes into that chat, through the platform's own file call, when the chat's row says it can take
 * files. The library copy stays whatever happens; the words say what reached the chat.
 */
async function postToChat(
  port: ChannelPort | undefined,
  ctx: ToolContext,
  origin: ChannelOrigin,
  file: { name: string; mime: string; bytes: Uint8Array },
): Promise<string> {
  const send = port?.sendFile;
  if (send === undefined || !chatCapabilities(origin.kind, await channelGrants(ctx.store, origin)).files.send) return ' This chat cannot take files, so it is only in your library.';
  const outcome = await ctx.step('send_file_chat', () => send.call(port, { ownerId: ctx.ownerId, origin, file }));
  if (outcome.status === 'ok') return ' It is also posted in this chat.';
  if (outcome.status === 'unsupported') return ' This chat cannot take files, so it is only in your library.';
  if (outcome.status === 'skipped') return ' ' + outcome.reason + ' It is only in your library.';
  return ' It could not be posted to this chat (' + outcome.error + '); it is in your library.';
}

export function createSendFileTool(opts: SandboxOpts & { store: Store; channels?: ChannelPort }): Tool {
   return {
     name: 'send_file',
     description: '',
     parameters: {
       type: 'object',
       properties: {
         path: { type: 'string' },
         name: { type: 'string' },
         mimeType: { type: 'string' },
       },
       required: ['path'],
       additionalProperties: false,
     },
     replay: 'never',
     sideEffect: true,
     async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
       const parsed = sendFileSchema.parse(args);
       throwIfAborted(ctx.signal);
       const pathError = invalidPath(parsed.path);
       if (pathError !== undefined) return errorResult(pathError);
       const auth = await requireRequesterContext(ctx);
       if (!auth.ok) return errorResult(auth.error);
       const requester = auth.value;
      const membershipError = await validateCurrentConversation(opts.store, ctx, requester);
      if (membershipError !== undefined) return errorResult(membershipError);
      let resolved: string;
      try {
        resolved = await resolveToolPath(opts, ctx, parsed.path);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
      const fallbackName = posix.basename(resolved);
      const fileName = parsed.name !== undefined ? parsed.name.trim() : fallbackName;
      if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
        return errorResult('Error: file name must be a plain file name without path separators.');
      }
       const mimeType = parsed.mimeType !== undefined ? parsed.mimeType.trim() : 'application/octet-stream';
       if (mimeType.length === 0 || mimeType.includes(' ') || !mimeType.includes('/')) {
         return errorResult('Error: mimeType must look like type/subtype.');
       }
      throwIfAborted(ctx.signal);
      const decoded = await readSandboxFile(opts, ctx, resolved);
      if (!decoded.ok) return decoded.error;
       const scoped = opts.store.forOwner?.(requester.ownerId);
       if (!scoped) return errorResult('Error: owner-scoped storage is unavailable; nothing was saved.');
       const now = nowIso();
       const size = mimeType.startsWith('image/') ? imageSize(decoded.value.bytes) : undefined;
       const libraryId = newId('lib');
       const document: LibraryDocument = {
         id: libraryId,
         name: fileName,
         kind: 'file',
         mimeType,
         sizeBytes: decoded.value.sizeBytes,
         ...(size ?? {}),
         createdByAgentId: ctx.agentId,
         conversationId: ctx.conversationId,
         runId: ctx.runId,
         shared: 'private',
         source: 'agent',
         tags: [],
         createdAt: now,
         updatedAt: now,
         pinned: false,
         sha256: decoded.value.sha256,
       };
       const item = {
         id: newId('itm'),
         conversationId: ctx.conversationId,
         type: 'artifact' as const,
         artifactId: libraryId,
         at: now,
       };
       try {
         await ctx.step('send_file', async () => {
           const stored = await saveBlob(ctx.blobs, decoded.value.bytes, mimeType);
           await scoped.tx(async (tx) => {
             await tx.put('library', { ...document, blobKey: stored.blobKey }, { conversationId: ctx.conversationId });
             await tx.put('items', item, { conversationId: ctx.conversationId });
             await emitItemAdded(tx, ctx.conversationId, item);
           });
         });
       } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return errorResult('Error: the file was read but could not be saved: ' + message);
       }
       const origin = replyOriginOf([ctx.wake]);
       const chatNote = origin === undefined ? '' : await postToChat(opts.channels, ctx, origin, { name: fileName, mime: mimeType, bytes: decoded.value.bytes });
       return {
         content: [{ type: 'text', text: 'Saved ' + fileName + ' (' + String(decoded.value.sizeBytes) + ' bytes, ' + mimeType + ') to your library.' + chatNote }],
         details: { libraryId, artifactId: libraryId, name: fileName, mimeType, sizeBytes: decoded.value.sizeBytes, sha256: decoded.value.sha256 },
       };
     },
   };
}
