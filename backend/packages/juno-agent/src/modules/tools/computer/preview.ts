/**
 * A screenshot of the agent's screen saved to the owner's library, for an approval card (BACKEND 8.7).
 * The bytes go screen → blob store, named by a library row; the model never sees them and the request only names the row, so
 * a client fetches the image through the owner-scoped `GET /v1/library/:id/download`.
 */
import { saveBlob, type ApprovalDetailsContext, type LibraryDocument } from '../../../contracts/index.js';
import { imageSize } from '@agent-desktop/public-contracts';
import { newId, nowIso } from '../util.js';
import type { ComputerTarget } from '../../../ports/computer/index.js';
import { requireComputerClient, type ComputerClientProvider } from './client.js';

export async function saveScreenPreview(
  provider: ComputerClientProvider | undefined,
  ctx: ApprovalDetailsContext,
  on?: ComputerTarget,
): Promise<{ libraryId: string; capturedAt: string } | undefined> {
  const scoped = ctx.store.forOwner?.(ctx.ownerId);
  const conversation = await ctx.store.get('conversations', ctx.conversationId);
  if (!scoped || !conversation) return undefined;
  const shot = await requireComputerClient(provider).screenshot(ctx.agentId, ctx.signal, on);
  const bytes = Buffer.from(shot.data, 'base64');
  const capturedAt = nowIso();
  const size = imageSize(bytes);
  const stored = await saveBlob(ctx.blobs, bytes, shot.mimeType);
  const document: LibraryDocument = {
    id: newId('lib'),
    name: `approval-preview-${capturedAt.replace(/[:.]/g, '-')}.${shot.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
    kind: 'image',
    mimeType: shot.mimeType,
    sizeBytes: bytes.length,
    ...(size ?? {}),
    createdByAgentId: ctx.agentId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    shared: 'private',
    source: 'agent',
    tags: ['approval-preview'],
    createdAt: capturedAt,
    updatedAt: capturedAt,
    pinned: false,
    blobKey: stored.blobKey,
    sha256: stored.sha256,
  };
  await scoped.put('library', document, { conversationId: ctx.conversationId });
  return { libraryId: document.id, capturedAt };
}
