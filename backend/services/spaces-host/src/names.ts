/**
 * Names and limits shared by the publisher (in the API) and the Worker: the host label of a publication, its object keys in R2,
 * the content types of the files, and the sizes a publish may not exceed. Pure, no runtime APIs.
 */

export const VISIBILITIES = ['private', 'link', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const DEFAULT_VISIBILITY: Visibility = 'link';

/** A publication's id, also the unguessable part of its host label: 80 random bits, lower-case hex. */
const LINK_ID = /^[0-9a-f]{20}$/;
/** The Space's folder name (BACKEND 5.12, space_publish): lower-case letters, digits and dashes. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** A host label `<slug>-<linkId>`: at most 62 characters, so it is a valid DNS label. */
const HOST_LABEL = /^([a-z0-9][a-z0-9-]{0,40})-([0-9a-f]{20})$/;

export const MAX_FILES = 500;
export const MAX_FILE_BYTES_TOTAL = 10 * 1024 * 1024;
export const MAX_ROWS_PER_PUBLICATION = 10_000;
export const MAX_ROW_BYTES = 16 * 1024;

export function isVisibility(value: unknown): value is Visibility {
  return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value);
}

export function isLinkId(value: string): boolean {
  return LINK_ID.test(value);
}

export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

/** The host label of a publication (`<slug>-<linkId>`), or undefined when the parts are not valid. */
export function hostLabel(slug: string, linkId: string): string | undefined {
  if (!isSlug(slug) || !isLinkId(linkId)) return undefined;
  return `${slug}-${linkId}`;
}

/** The link id inside a host label, or undefined when the label is not one of ours. */
export function linkIdOfLabel(label: string): string | undefined {
  const match = HOST_LABEL.exec(label);
  return match === null ? undefined : match[2];
}

/** A new link id: 80 random bits as lower-case hex. */
export function newLinkId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Where a file of a publication version is kept in R2. */
export function objectKey(linkId: string, version: number, path: string): string {
  return `${linkId}/${String(version)}/${path}`;
}

/** A path inside the Space's build: relative, no dot segments, plain characters only. */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  if (!/^[A-Za-z0-9._@+/-]+$/.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}

/** A table name of the Space's data: the snake_case names SQLite gives tables. */
export function isSafeTable(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(name);
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
};

/** The content type of a file by its extension; unknown types are served as bytes, never sniffed. */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}
