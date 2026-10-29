/**
 * The publisher of hosted Spaces (BACKEND 5.12, option B): it writes a Space's pages to R2 and its rows to D1 as one version
 * of a publication, and changes or revokes the publication. It talks to a `HostedStorage`, which is the Cloudflare REST API in
 * production (cloudflare-storage.ts) and the local `wrangler dev` in development and tests (local-storage.ts).
 * The Worker (serve.ts) reads what this writes.
 */
import { signLinkToken } from './tokens.js';
import {
  DEFAULT_VISIBILITY,
  MAX_FILE_BYTES_TOTAL,
  MAX_FILES,
  MAX_ROWS_PER_PUBLICATION,
  contentTypeFor,
  hostLabel,
  isLinkId,
  isSafePath,
  isSafeTable,
  isSlug,
  isVisibility,
  newLinkId,
  objectKey,
  type Visibility,
} from './names.js';
import type { HostedRow, SnapshotFile } from './snapshot.js';

export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

/** The two things the publisher needs from a storage: D1 (SQL) and R2 (objects). */
export interface HostedStorage {
  query(sql: string, params: SqlValue[]): Promise<Array<Record<string, unknown>>>;
  /** Run the statements in order. The local storage runs them as one atomic batch; the REST API runs them one by one (see README). */
  execute(statements: Statement[]): Promise<void>;
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Delete every object whose key starts with `prefix` (all versions of a revoked publication). */
  deletePrefix(prefix: string): Promise<void>;
}

/** A refused request: `not_found` (no live publication), `invalid` (the input cannot be hosted), `storage` (the storage failed),
 *  `server_code` (the Space runs its own server code, which hosting does not run). */
export class HostedError extends Error {
  readonly code: 'not_found' | 'invalid' | 'storage' | 'server_code';
  constructor(code: 'not_found' | 'invalid' | 'storage' | 'server_code', message: string) {
    super(message);
    this.name = 'HostedError';
    this.code = code;
  }
}

export interface HostedPublisherOptions {
  storage: HostedStorage;
  /** HMAC key of the owner links; the Worker needs the same value (SPACES_HOST_SIGNING_KEY). */
  signingKey: string;
  contentScheme: 'http' | 'https';
  /** The domain published Spaces live under (`<slug>-<linkId>.<contentDomain>`). */
  contentDomain: string;
  now?: () => number;
}

/** Who may do what on a publication. Visitors (no owner session) may always read; `visitorWrites` lets them change the data too. */
export interface Access {
  visibility?: Visibility;
  visitorWrites?: boolean;
}

export interface PublishInput extends Access {
  /** The publication to update (its URL stays the same); omitted = a new publication. */
  linkId?: string;
  slug: string;
  files: SnapshotFile[];
  /** The Space's data: table name -> rows. Replaces the rows the publication held. */
  tables: Record<string, HostedRow[]>;
}

export interface PublishedLink {
  linkId: string;
  url: string;
  version: number;
  visibility: Visibility;
  visitorWrites: boolean;
}

export interface HostedSpacesPublisher {
  /** A new publication (defaults: visibility `link`, visitors read-only), or a new version of `linkId` (keeps the access unless given). */
  publish(input: PublishInput): Promise<PublishedLink>;
  setAccess(linkId: string, access: Access): Promise<{ visibility: Visibility; visitorWrites: boolean }>;
  /** Makes the link answer 404 and drops its rows and pages. Revoking a revoked link does nothing. */
  revoke(linkId: string): Promise<void>;
  /** The URL that opens a private Space for its owner (it sets the session cookie there), valid until `expiresAt` (epoch ms). */
  ownerOpenUrl(linkId: string, expiresAt: number): Promise<string>;
}

interface Current {
  host: string;
  visibility: Visibility;
  visitorWrites: boolean;
  version: number;
  revoked: boolean;
}

export function createHostedPublisher(options: HostedPublisherOptions): HostedSpacesPublisher {
  const { storage, signingKey, contentScheme, contentDomain } = options;
  const now = options.now ?? Date.now;
  const iso = (): string => new Date(now()).toISOString();
  /** The address of a publication: its host label under the content domain. */
  const origin = (label: string): string => `${contentScheme}://${label}.${contentDomain}`;

  async function current(linkId: string): Promise<Current | null> {
    if (!isLinkId(linkId)) return null;
    const rows = await storage.query('SELECT host, visibility, visitor_writes, version, revoked_at FROM publications WHERE id = ?', [linkId]);
    const row = rows[0];
    if (row === undefined) return null;
    if (!isVisibility(row['visibility'])) throw new HostedError('storage', 'a publication has an unknown visibility');
    const revokedAt = row['revoked_at'];
    return {
      host: String(row['host']),
      visibility: row['visibility'],
      visitorWrites: Number(row['visitor_writes']) === 1,
      version: Number(row['version']),
      revoked: revokedAt !== null && revokedAt !== undefined,
    };
  }

  async function live(linkId: string): Promise<Current> {
    const row = await current(linkId);
    if (row === null || row.revoked) throw new HostedError('not_found', 'this Space has no live hosted link');
    return row;
  }

  return {
    async publish(input) {
      const { slug, files } = input;
      if (!isSlug(slug)) throw new HostedError('invalid', 'the Space folder name is not a valid host label');
      checkFiles(files);
      checkTables(input.tables);

      const existing = input.linkId === undefined ? null : await live(input.linkId);
      const linkId = input.linkId ?? newLinkId();
      const version = existing === null ? 1 : existing.version + 1;
      const host = existing?.host ?? hostLabel(slug, linkId);
      if (host === undefined) throw new HostedError('invalid', 'the Space folder name is not a valid host label');
      const visibility = input.visibility ?? existing?.visibility ?? DEFAULT_VISIBILITY;
      const visitorWrites = input.visitorWrites ?? existing?.visitorWrites ?? false;
      const at = iso();

      // The pages first: nothing points at a version until the publication row names it (below).
      for (const file of files) await storage.putObject(objectKey(linkId, version, file.path), file.bytes, contentTypeFor(file.path));

      const publication: Statement =
        existing === null
          ? {
              sql: 'INSERT INTO publications (id, host, visibility, visitor_writes, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              params: [linkId, host, visibility, visitorWrites ? 1 : 0, version, at, at],
            }
          : {
              sql: 'UPDATE publications SET visibility = ?, visitor_writes = ?, version = ?, updated_at = ? WHERE id = ?',
              params: [visibility, visitorWrites ? 1 : 0, version, at, linkId],
            };
      const statements: Statement[] = [publication, { sql: 'DELETE FROM space_rows WHERE publication_id = ?', params: [linkId] }];
      for (const [table, rows] of Object.entries(input.tables)) {
        for (const row of rows) {
          statements.push({ sql: 'INSERT INTO space_rows (publication_id, table_name, row_id, body) VALUES (?, ?, ?, ?)', params: [linkId, table, row.rowId, JSON.stringify(row.body)] });
        }
      }
      await storage.execute(statements);
      return { linkId, url: `${origin(host)}/`, version, visibility, visitorWrites };
    },

    async setAccess(linkId, access) {
      const row = await live(linkId);
      const visibility = access.visibility ?? row.visibility;
      const visitorWrites = access.visitorWrites ?? row.visitorWrites;
      await storage.execute([{ sql: 'UPDATE publications SET visibility = ?, visitor_writes = ?, updated_at = ? WHERE id = ?', params: [visibility, visitorWrites ? 1 : 0, iso(), linkId] }]);
      return { visibility, visitorWrites };
    },

    async revoke(linkId) {
      const row = await current(linkId);
      if (row === null) throw new HostedError('not_found', 'this Space has no hosted link');
      if (row.revoked) return;
      // Dead first (the Worker answers 404 from this row on), then the data and the pages of every version.
      const at = iso();
      await storage.execute([
        { sql: 'UPDATE publications SET revoked_at = ?, updated_at = ? WHERE id = ?', params: [at, at, linkId] },
        { sql: 'DELETE FROM space_rows WHERE publication_id = ?', params: [linkId] },
      ]);
      await storage.deletePrefix(linkId + '/');
    },

    async ownerOpenUrl(linkId, expiresAt) {
      const row = await live(linkId);
      const token = await signLinkToken({ kind: 'owner', pub: linkId, exp: expiresAt }, signingKey);
      return `${origin(row.host)}/__auth?t=${token}`;
    },
  };
}

function checkFiles(files: readonly SnapshotFile[]): void {
  if (files.length > MAX_FILES) throw new HostedError('invalid', `a Space has at most ${String(MAX_FILES)} files`);
  let total = 0;
  for (const file of files) {
    if (!isSafePath(file.path)) throw new HostedError('invalid', `file name not hostable: ${file.path}`);
    total += file.bytes.byteLength;
  }
  if (total > MAX_FILE_BYTES_TOTAL) throw new HostedError('invalid', `the pages are larger than ${String(MAX_FILE_BYTES_TOTAL)} bytes`);
  if (!files.some((file) => file.path === 'index.html')) throw new HostedError('invalid', 'the Space has no built index.html');
}

function checkTables(tables: Record<string, HostedRow[]>): void {
  let rows = 0;
  for (const [name, list] of Object.entries(tables)) {
    if (!isSafeTable(name)) throw new HostedError('invalid', `table name not hostable: ${name}`);
    rows += list.length;
  }
  if (rows > MAX_ROWS_PER_PUBLICATION) throw new HostedError('invalid', `the data has more than ${String(MAX_ROWS_PER_PUBLICATION)} rows`);
}
