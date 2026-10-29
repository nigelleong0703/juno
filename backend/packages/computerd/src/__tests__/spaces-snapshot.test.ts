/** The snapshot program of a published Space (transport/spaces-snapshot.ts): run for real with sh and python3 on fixture folders. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snapshotCommand } from '../transport/spaces-snapshot.js';

interface Snapshot {
  root: string;
  files: Array<{ path: string; base64: string }>;
  tables: Record<string, Array<Record<string, unknown>>>;
  serverCode: string[];
}

let base = '';
let spaces = '';
let templates = '';

/** Run the program on one Space of the fixture; `templatesDir` overrides where the app template is looked up. */
function run(slug: string, templatesDir = templates): Snapshot {
  const stdout = execFileSync('sh', ['-c', snapshotCommand(slug)], { env: { ...process.env, JUNO_SPACES_ROOT: spaces, JUNO_SPACES_TEMPLATES: templatesDir }, encoding: 'utf8' });
  return JSON.parse(stdout) as Snapshot;
}

function failure(slug: string, templatesDir = templates): string {
  try {
    execFileSync('sh', ['-c', snapshotCommand(slug)], { env: { ...process.env, JUNO_SPACES_ROOT: spaces, JUNO_SPACES_TEMPLATES: templatesDir }, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? '');
  }
  throw new Error('the snapshot should have failed');
}

/** A folder with the given files (relative paths to contents). */
function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

const APP_SERVER = 'export const server = "template";\n';
const APP_DB = 'export const db = "template";\n';
const STATIC_SERVER = 'static server\n';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'juno-snapshot-'));
  spaces = join(base, 'spaces');
  templates = join(base, 'templates');
  write(join(templates, 'app'), { 'server.ts': APP_SERVER, 'db.ts': APP_DB, 'schema.ts': 'template schema\n', 'src/App.tsx': 'x' });
  write(join(templates, 'static'), { 'server.ts': STATIC_SERVER, 'public/index.html': 'x' });

  // A plain app: the template's server files, its own tables and client.
  write(join(spaces, 'notes'), {
    'dist/index.html': '<p>hi</p>',
    'dist/assets/app.js': 'run()',
    'dist/.hidden': 'secret',
    'server.ts': APP_SERVER,
    'db.ts': APP_DB,
    'schema.ts': 'the app schema, which may differ\n',
    'src/App.tsx': 'client',
  });
  mkdirSync(join(spaces, 'notes', 'data'), { recursive: true });
  execFileSync('python3', [
    '-c',
    'import sqlite3, sys\nc = sqlite3.connect(sys.argv[1])\nc.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)")\nc.execute("INSERT INTO notes (text, created_at) VALUES (\'a\', \'x\')")\nc.execute("CREATE TABLE __drizzle_migrations (id INTEGER)")\nc.commit()\nc.close()',
    join(spaces, 'notes', 'data', 'app.db'),
  ]);

  write(join(spaces, 'site'), { 'public/index.html': '<p>static</p>', 'server.ts': STATIC_SERVER });

  // Server code the owner or the agent added or changed.
  write(join(spaces, 'custom'), { 'dist/index.html': 'x', 'server.ts': 'export const server = "changed";\n', 'db.ts': APP_DB });
  write(join(spaces, 'extra'), { 'dist/index.html': 'x', 'server.ts': APP_SERVER, 'db.ts': APP_DB, 'helpers.ts': 'export {};\n' });
  write(join(spaces, 'missing'), { 'dist/index.html': 'x', 'server.ts': APP_SERVER });
  write(join(spaces, 'apidir'), { 'dist/index.html': 'x', 'server.ts': APP_SERVER, 'db.ts': APP_DB, 'api/routes.ts': 'x' });
  write(join(spaces, 'draft'), { 'src/App.tsx': 'x' });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('spaces snapshot', () => {
  it('reads the built pages and the data rows of an app, without hidden files or migrations', () => {
    const snapshot = run('notes');
    expect(snapshot.root).toBe('dist');
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(['assets/app.js', 'index.html']);
    expect(snapshot.files.find((file) => file.path === 'index.html')?.base64).toBe(Buffer.from('<p>hi</p>').toString('base64'));
    expect(snapshot.tables).toEqual({ notes: [{ id: 1, text: 'a', created_at: 'x' }] });
    expect(snapshot.serverCode).toEqual([]);
  });

  it('reads a static Space from public/, whose server file is the static template\'s', () => {
    const snapshot = run('site');
    expect(snapshot.root).toBe('public');
    expect(snapshot.tables).toEqual({});
    expect(snapshot.serverCode).toEqual([]);
  });

  it('reports every server file that is not the template\'s: changed, extra, missing, and new folders', () => {
    expect(run('custom').serverCode).toEqual(['server.ts']);
    expect(run('extra').serverCode).toEqual(['helpers.ts']);
    expect(run('missing').serverCode).toEqual(['db.ts']);
    expect(run('apidir').serverCode).toEqual(['api/']);
  });

  it('refuses a folder with no built page, a slug that is not one, a path that leaves the spaces folder, and a computer without the template', () => {
    expect(failure('draft')).toContain('no built index.html');
    expect(failure('Bad_Slug')).toContain('bad slug');
    expect(failure('../notes')).toContain('bad slug');
    expect(failure('notes', join(base, 'no-such-templates'))).toContain('the spaces template is not on this computer');
  });
});
