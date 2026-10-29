/** Published artifacts (BACKEND 5.11): metadata with versions, per-version downloads and the HTML bytes behind the artifact origin. */
import type { BlobStore, Store } from '@agent-desktop/contracts';
import { artifactSchema } from '@agent-desktop/public-contracts';
import type { Artifact, ArtifactCsp, ArtifactPart, ArtifactVersion } from '@agent-desktop/public-contracts';
import { verifiedDownload, type LibraryDownloadResult } from './library.js';

export interface ArtifactsModule {
  get(id: string): Promise<Artifact | null>;
  version(id: string, version: number): Promise<ArtifactVersion | null>;
  download(id: string, version: number, part: ArtifactPart): Promise<LibraryDownloadResult>;
  /** The HTML of one version, for the artifact origin; null unless it is an html artifact version. */
  html(id: string, version: number): Promise<{ html: Buffer; csp?: ArtifactCsp } | null>;
}

export function createArtifactsModule(scoped: Store, blobs: BlobStore): ArtifactsModule {
  const find = async (id: string, version: number): Promise<{ artifact: Artifact; version: ArtifactVersion } | null> => {
    const doc = await scoped.get('library', id);
    if (doc === null) return null;
    const artifact = artifactSchema.parse(doc);
    const found = artifact.versions?.find((candidate) => candidate.version === version);
    return found === undefined ? null : { artifact, version: found };
  };

  const download = async (id: string, version: number, part: ArtifactPart): Promise<LibraryDownloadResult> => {
    const found = await find(id, version);
    if (found === null) return { status: 'not_found' };
    const ref = part === 'file' ? found.version.fileRef : part === 'preview' ? found.version.previewRef : found.version.thumbnailRef;
    if (ref === undefined) return { status: 'not_found' };
    const row = await scoped.get('artifactFiles', ref);
    if (row === null || row.artifactId !== id || row.version !== version) return { status: 'unavailable', reason: 'the stored file is missing' };
    return verifiedDownload(blobs, row);
  };

  return {
    async get(id: string): Promise<Artifact | null> {
      const doc = await scoped.get('library', id);
      return doc === null ? null : artifactSchema.parse(doc);
    },
    async version(id: string, version: number): Promise<ArtifactVersion | null> {
      return (await find(id, version))?.version ?? null;
    },
    download,
    async html(id: string, version: number): Promise<{ html: Buffer; csp?: ArtifactCsp } | null> {
      const found = await find(id, version);
      if (found === null || found.artifact.render !== 'html') return null;
      const file = await download(id, version, 'file');
      if (file.status !== 'ok') return null;
      return { html: Buffer.from(file.file.contentBase64, 'base64'), ...(found.version.csp === undefined ? {} : { csp: found.version.csp }) };
    },
  };
}
