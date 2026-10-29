/**
 * What the platform reads from a Space on its computer (computerd's `/v1/spaces/snapshot`, BACKEND 5.12 option B): the built
 * pages (`dist/` of an app, `public/` of a static one) and the rows of `data/app.db`, one list per table. Parsed here, so a
 * malformed answer from the computer is refused before anything is published.
 */
import { z } from 'zod';
import { HostedError } from './publisher.js';
import { MAX_FILE_BYTES_TOTAL, MAX_FILES, MAX_ROWS_PER_PUBLICATION, isSafePath, isSafeTable } from './names.js';

/** Said to the owner when a Space runs its own server code (the hosted copy does not run it). */
export const SERVER_CODE_MESSAGE = 'This Space runs its own server code; it can only be shared from your computer (option A)';

export const spaceSnapshotSchema = z.object({
  /** Which folder of the Space the pages came from. */
  root: z.enum(['dist', 'public']),
  files: z.array(z.object({ path: z.string(), base64: z.string() })).max(MAX_FILES),
  /** table name (snake_case, as SQLite has it) -> its rows as column -> value objects. */
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(MAX_ROWS_PER_PUBLICATION)),
  /** Server files that are not the app template's, as the computer found them (a changed or extra file, a missing one, a new folder). */
  serverCode: z.array(z.string()).max(MAX_FILES).default([]),
});

export type SpaceSnapshot = z.infer<typeof spaceSnapshotSchema>;

export interface SnapshotFile {
  path: string;
  bytes: Uint8Array;
}

/** One stored row of a hosted table: the id the client sees, and the other fields (camelCase, as the Space's client reads them). */
export interface HostedRow {
  rowId: string;
  body: Record<string, unknown>;
}

const camel = (column: string): string => column.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/** Decode and check the files and tables of a snapshot; throws with the reason when a file or table cannot be hosted. */
export function hostableSnapshot(snapshot: SpaceSnapshot): { files: SnapshotFile[]; tables: Record<string, HostedRow[]> } {
  if (snapshot.serverCode.length > 0) throw new HostedError('server_code', SERVER_CODE_MESSAGE);
  const files: SnapshotFile[] = [];
  let total = 0;
  for (const file of snapshot.files) {
    if (!isSafePath(file.path)) throw new Error(`file name not hostable: ${file.path}`);
    const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
    total += bytes.byteLength;
    if (total > MAX_FILE_BYTES_TOTAL) throw new Error(`the pages are larger than ${String(MAX_FILE_BYTES_TOTAL)} bytes`);
    files.push({ path: file.path, bytes });
  }
  if (!files.some((file) => file.path === 'index.html')) throw new Error('the Space has no built index.html (run spaces_tool.py build)');

  const tables: Record<string, HostedRow[]> = {};
  let rows = 0;
  for (const [name, list] of Object.entries(snapshot.tables)) {
    if (!isSafeTable(name)) throw new Error(`table name not hostable: ${name}`);
    rows += list.length;
    if (rows > MAX_ROWS_PER_PUBLICATION) throw new Error(`the data has more than ${String(MAX_ROWS_PER_PUBLICATION)} rows`);
    tables[name] = list.map((row, index) => {
      const { id, ...rest } = row;
      const body: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(rest)) body[camel(column)] = value;
      return { rowId: id === undefined || id === null ? String(index + 1) : String(id), body };
    });
  }
  return { files, tables };
}
