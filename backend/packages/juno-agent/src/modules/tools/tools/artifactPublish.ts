/**
 * artifact_publish: turn a finished file in the agent's computer into a chat artifact (BACKEND 5.11).
 *
 * The agent writes content with its ordinary file tools; this is the only platform step. The bytes go
 * sandbox -> blob store without entering the model context (same reader as send_file). The row is a
 * `library` entry (the artifact: render, newest `version`, `versions[]` metadata) whose files are
 * `artifactFiles` rows (metadata + blobKey), one per file, PDF preview and thumbnail of each version. Publishing again with
 * `artifactId` adds a version to the same artifact: the card in the chat shows the newest and older versions
 * stay retrievable. HTML pages may carry a sibling `<name>.csp.json` with the https origins they load from
 * (MCP Apps `_meta.ui.csp.resourceDomains`).
 *
 * replay is never, like send_file: the sandbox read and the store write are committed side effects.
 */
import { z } from 'zod';
import {
  artifactCspSchema,
  artifactRenderForName,
  artifactSchema,
  imageSize,
  type ArtifactCsp,
  type ArtifactKind,
  type ArtifactRender,
  type ArtifactVersion,
} from '@agent-desktop/public-contracts';
import { saveBlob, type ArtifactFile, type BlobRef, type BlobStore, type LibraryDocument, type Store, type Tool, type ToolContext, type ToolResult } from '../../../contracts/index.js';
import { recordPublishedArtifact } from '../../memory/artifact-note.js';
import type { MemoryPort } from '../../memory/port.js';
import { computerFailure } from '../computer/shared.js';
import { newId, nowIso } from '../util.js';
import { requireRequesterContext } from './relationPolicy.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { buildPreviews, type Previews } from './artifactPreview.js';
import {
  errorResult,
  invalidPath,
  readSandboxFile,
  resolveToolPath,
  throwIfAborted,
  validateCurrentConversation,
  type DecodedFile,
  type SandboxOpts,
} from './sandboxFile.js';

const publishSchema = z.object({
  path: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  artifactId: z.string().min(1).optional(),
});

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeTypeForName(name: string): string {
  return MIME_BY_EXTENSION[name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''] ?? 'application/octet-stream';
}

/** The library `kind` a render maps to (the older coarse classification clients already filter on). */
export function kindForRender(render: ArtifactRender, name: string): ArtifactKind {
  if (render === 'html') return 'canvas';
  if (render === 'image') return 'image';
  if (render === 'video') return 'file';
  return name.toLowerCase().endsWith('.md') || /\.(pdf|docx|pptx|xlsx)$/i.test(name) ? 'document' : 'file';
}

/** `<dir>/<stem>.csp.json` for an HTML file path. */
export function cspSidecarPath(htmlPath: string): string {
  return htmlPath.replace(/\.[^./]+$/, '') + '.csp.json';
}

/** Parse the sidecar text; only https origins are accepted. */
export function parseCspSidecar(text: string): { ok: true; csp: ArtifactCsp } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'it is not valid JSON' };
  }
  const parsed = artifactCspSchema.safeParse(raw);
  if (parsed.success) return { ok: true, csp: parsed.data };
  return { ok: false, error: 'expected {"resourceDomains": ["https://host", ...]} with https origins only (no path, no wildcard): ' + parsed.error.issues[0]?.message };
}

export interface VersionFiles {
  file: ArtifactFile;
  preview?: ArtifactFile;
  thumbnail?: ArtifactFile;
}

/** Version bookkeeping: the next number and the artifact row after adding it. Pure, so the rules are testable. */
export function addVersion(current: LibraryDocument | null, input: { title: string; render: ArtifactRender; kind: ArtifactKind; mimeType: string; sizeBytes: number; at: string; make: (version: number) => ArtifactVersion; base: Omit<LibraryDocument, 'name' | 'kind' | 'mimeType' | 'sizeBytes' | 'updatedAt' | 'render' | 'version' | 'versions'> }): { artifact: LibraryDocument; version: ArtifactVersion } {
  const version = input.make((current?.version ?? 0) + 1);
  const artifact: LibraryDocument = {
    ...(current ?? input.base),
    name: input.title,
    kind: input.kind,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    updatedAt: input.at,
    render: input.render,
    version: version.version,
    versions: [...(current?.versions ?? []), version],
  };
  return { artifact, version };
}

/** One version file: the row keeps where its bytes are in the blob store. */
function fileRow(artifactId: string, version: number, part: ArtifactFile['part'], name: string, mimeType: string, stored: BlobRef, at: string): ArtifactFile {
  return { id: newId('af'), artifactId, version, part, name, mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, blobKey: stored.blobKey, createdAt: at };
}

/** The bytes go to the blob store before the row transaction, so no object-store call runs under the artifact's row lock. */
async function storeFiles(blobs: BlobStore, mimeType: string, file: DecodedFile, previews: Previews): Promise<{ file: BlobRef; preview?: BlobRef; thumbnail?: BlobRef }> {
  return {
    file: await saveBlob(blobs, file.bytes, mimeType),
    ...(previews.preview === undefined ? {} : { preview: await saveBlob(blobs, previews.preview.bytes, 'application/pdf') }),
    ...(previews.thumbnail === undefined ? {} : { thumbnail: await saveBlob(blobs, previews.thumbnail.bytes, 'image/png') }),
  };
}

export function createArtifactPublishTool(opts: SandboxOpts & { store: Store; memory?: MemoryPort }): Tool {
  return {
    name: 'artifact_publish',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '' },
        title: { type: 'string', description: '' },
        artifactId: { type: 'string', description: '' },
      },
      required: ['path', 'title'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = publishSchema.parse(args);
      throwIfAborted(ctx.signal);
      const pathError = invalidPath(parsed.path);
      if (pathError !== undefined) return errorResult(pathError);
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return errorResult(auth.error);
      const requester = auth.value;
      const membershipError = await validateCurrentConversation(opts.store, ctx, requester);
      if (membershipError !== undefined) return errorResult(membershipError);
      const scoped = opts.store.forOwner?.(requester.ownerId);
      if (!scoped) return errorResult('Error: owner-scoped storage is unavailable; nothing was saved.');

      let resolved: string;
      try {
        resolved = await resolveToolPath(opts, ctx, parsed.path);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
      const fileName = resolved.split('/').pop() ?? '';
      const render = artifactRenderForName(fileName);
      if (render === undefined) {
        return errorResult('Error: ' + fileName + ' cannot be published as an artifact (supported: html, pdf, docx, pptx, xlsx, md, png, jpg, webp, gif, mp4, webm). Use send_file to hand it over as a plain file.');
      }
      if (parsed.artifactId !== undefined) {
        const existing = await scoped.get('library', parsed.artifactId);
        const problem = existingProblem(existing, render, ctx.agentId);
        if (problem !== undefined) return errorResult(problem);
      }

      throwIfAborted(ctx.signal);
      const file = await readSandboxFile(opts, ctx, resolved);
      if (!file.ok) return file.error;
      if (file.value.sizeBytes === 0) return errorResult('Error: the file is empty; nothing was published.');
      let csp: ArtifactCsp | undefined;
      if (render === 'html') {
        const sidecar = await readCsp(opts, ctx, resolved);
        if (!sidecar.ok) return errorResult(sidecar.error);
        csp = sidecar.csp;
      }
      throwIfAborted(ctx.signal);
      const previews: Previews = await buildPreviews(opts, ctx, resolved, fileName);

      const artifactId = parsed.artifactId ?? newId('lib');
      const at = nowIso();
      const mimeType = mimeTypeForName(fileName);
      const size = render === 'image' ? imageSize(file.value.bytes) : undefined;
      let published: { artifact: LibraryDocument; version: ArtifactVersion; created: boolean };
      try {
        published = await ctx.step('artifact_publish', async () => {
          const stored = await storeFiles(ctx.blobs, mimeType, file.value, previews);
          return scoped.tx(async (tx) => {
            const current = parsed.artifactId === undefined ? null : await (tx.getForUpdate?.('library', artifactId) ?? tx.get('library', artifactId));
            if (parsed.artifactId !== undefined) {
              const problem = existingProblem(current, render, ctx.agentId);
              if (problem !== undefined) throw new Error(problem.replace(/^Error: /, ''));
            }
            const number = (current?.version ?? 0) + 1;
            const rows: VersionFiles = {
              file: fileRow(artifactId, number, 'file', fileName, mimeType, stored.file, at),
              ...(stored.preview === undefined ? {} : { preview: fileRow(artifactId, number, 'preview', fileName.replace(/\.[^.]+$/, '') + '.pdf', 'application/pdf', stored.preview, at) }),
              ...(stored.thumbnail === undefined ? {} : { thumbnail: fileRow(artifactId, number, 'thumbnail', fileName.replace(/\.[^.]+$/, '') + '.png', 'image/png', stored.thumbnail, at) }),
            };
            const result = addVersion(current, {
              title: parsed.title,
              render,
              kind: kindForRender(render, fileName),
              mimeType,
              sizeBytes: file.value.sizeBytes,
              at,
              make: (version) => ({
                version,
                fileRef: rows.file.id,
                sizeBytes: file.value.sizeBytes,
                mimeType,
                sha256: file.value.sha256,
                ...(rows.preview === undefined ? {} : { previewRef: rows.preview.id }),
                // An image is its own thumbnail.
                ...(rows.thumbnail === undefined ? (render === 'image' ? { thumbnailRef: rows.file.id } : {}) : { thumbnailRef: rows.thumbnail.id }),
                ...(csp === undefined ? {} : { csp }),
                createdAt: at,
              }),
              base: {
                id: artifactId,
                createdByAgentId: ctx.agentId,
                conversationId: ctx.conversationId,
                runId: ctx.runId,
                shared: 'private',
                source: 'agent',
                tags: [],
                createdAt: at,
                pinned: false,
                ...(size ?? {}),
              },
            });
            for (const row of [rows.file, rows.preview, rows.thumbnail]) {
              if (row !== undefined) await tx.put('artifactFiles', row, { parentId: artifactId, conversationId: ctx.conversationId });
            }
            await tx.put('library', { ...result.artifact, sourcePath: resolved }, { conversationId: result.artifact.conversationId ?? ctx.conversationId });
            // The artifact itself first, also on the first publish: a client draws the card only once it has the artifact.
            await tx.emit({ type: 'artifact.updated', artifact: artifactSchema.parse(result.artifact) });
            // A new card only when this chat has none for the artifact; otherwise the existing card updates in place.
            if (current === null || current.conversationId !== ctx.conversationId) {
              const item = { id: newId('itm'), conversationId: ctx.conversationId, type: 'artifact' as const, artifactId, version: number, at };
              await tx.put('items', item, { conversationId: ctx.conversationId });
              await emitItemAdded(tx, ctx.conversationId, item);
            }
            return { ...result, created: current === null };
          });
        });
      } catch (error) {
        return errorResult('Error: the file was read but could not be published: ' + (error instanceof Error ? error.message : String(error)));
      }
      const { version } = published;
      // Best effort: the publish is committed, so a memory failure is reported in the step details, never as a failed publish.
      let memoryError: string | undefined;
      if (opts.memory !== undefined) {
        try {
          const home = opts.computer?.()?.home;
          await recordPublishedArtifact(opts.store, opts.memory, { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, artifactId, title: parsed.title, version: version.version, sourcePath: resolved, at }, home);
        } catch (error) {
          memoryError = error instanceof Error ? error.message : String(error);
        }
      }
      const notes = previews.notes.length === 0 ? '' : ' Notes: ' + previews.notes.join('; ') + '.';
      return {
        content: [{ type: 'text', text: (published.created ? 'Published ' : 'Published version ' + String(version.version) + ' of ') + parsed.title + ' (' + render + ', ' + String(version.sizeBytes) + ' bytes) as artifact ' + artifactId + ' version ' + String(version.version) + '. Pass this artifactId to publish a new version.' + notes }],
        details: {
          artifactId,
          version: version.version,
          render,
          mimeType,
          sizeBytes: version.sizeBytes,
          ...(csp === undefined ? {} : { cspDomains: csp.resourceDomains.length }),
          preview: previews.preview !== undefined,
          thumbnail: previews.thumbnail !== undefined,
          ...(previews.notes.length === 0 ? {} : { notes: previews.notes }),
          ...(memoryError === undefined ? {} : { memoryRecordFailed: memoryError }),
        },
      };
    },
  };
}

/** Why an artifactId cannot take a new version, or undefined when it can. */
function existingProblem(existing: LibraryDocument | null, render: ArtifactRender, agentId: string): string | undefined {
  if (existing === null || existing.render === undefined) return 'Error: no artifact with this artifactId exists; publish without artifactId first.';
  if (existing.createdByAgentId !== agentId) return 'Error: this artifact was published by another agent; publish yours without artifactId.';
  if (existing.render !== render) return 'Error: a new version must have the same type as the artifact (' + existing.render + '); publish a different type as a new artifact.';
  return undefined;
}

/** The optional `<name>.csp.json` next to an HTML page; absent means the page declares no external origins. */
async function readCsp(opts: SandboxOpts, ctx: ToolContext, htmlPath: string): Promise<{ ok: true; csp?: ArtifactCsp } | { ok: false; error: string }> {
  const path = cspSidecarPath(htmlPath);
  const read = await readSandboxFile(opts, ctx, path);
  if (!read.ok) {
    if (read.missing) return { ok: true };
    return { ok: false, error: 'Error: could not read ' + path + '; nothing was published.' };
  }
  const parsed = parseCspSidecar(read.value.bytes.toString('utf8'));
  if (!parsed.ok) return { ok: false, error: 'Error: ' + path + ' is invalid: ' + parsed.error + '. Nothing was published.' };
  return { ok: true, csp: parsed.csp };
}
