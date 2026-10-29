/** The boot's data migrations: the runner's order, markers and failure policies, and the registry's entries run through it. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import type { Store } from 'juno-agent/contracts';
import { migrations } from '../migrations/registry.js';
import { runMigrations, type Migration, type MigrationLog } from '../migrations/runner.js';

interface Line {
  level: 'info' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

function recorder(): { log: MigrationLog; lines: Line[] } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (fields, message) => { lines.push({ level: 'info', fields, message }); },
      error: (fields, message) => { lines.push({ level: 'error', fields, message }); },
    },
  };
}

/** A migration that records its run and writes its marker, the way the real ones do. */
function step(name: string, ran: string[], options: Partial<Pick<Migration<{ store: Store }>, 'onFailure'>> & { fail?: boolean; notApplicable?: boolean } = {}): Migration<{ store: Store }> {
  const marker = '__migrations/' + name;
  return {
    name,
    marker,
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    async run({ store }) {
      ran.push(name);
      if (options.fail === true) throw new Error(name + ' broke');
      if (options.notApplicable === true) return { skipped: true };
      await putRow(store, newRow('system', marker, '', 'platform', new Date().toISOString()));
      return { skipped: false, counts: { rows: 2 } };
    },
  };
}

const markerDone = async (store: Store, marker: string): Promise<boolean> => (await getRow(store, 'system', marker)) !== null;

describe('runMigrations', () => {
  it('runs the pending migrations in order, logs each as done with its counts, and writes their markers', async () => {
    const store = createMemoryStore();
    const ran: string[] = [];
    const { log, lines } = recorder();
    const reports = await runMigrations([step('a', ran), step('b', ran), step('c', ran)], { store }, log);
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(reports).toEqual([{ name: 'a', status: 'done' }, { name: 'b', status: 'done' }, { name: 'c', status: 'done' }]);
    expect(lines.filter((line) => line.message === 'migration done').map((line) => line.fields)).toEqual([
      { migration: 'a', rows: 2 }, { migration: 'b', rows: 2 }, { migration: 'c', rows: 2 },
    ]);
    expect(await markerDone(store, '__migrations/b')).toBe(true);
  });

  it('skips a migration whose marker is already there, without running it, and runs the rest', async () => {
    const store = createMemoryStore();
    await putRow(store, newRow('system', '__migrations/b', '', 'platform', new Date().toISOString()));
    const ran: string[] = [];
    const { log, lines } = recorder();
    const reports = await runMigrations([step('a', ran), step('b', ran), step('c', ran)], { store }, log);
    expect(ran).toEqual(['a', 'c']);
    expect(reports.map((report) => report.status)).toEqual(['done', 'skipped', 'done']);
    expect(lines.some((line) => line.fields['migration'] === 'b' && line.message === 'migration skipped: already done')).toBe(true);
  });

  it('a failing migration (default policy) is logged by name, and the later ones do not run; the boot is not failed', async () => {
    const store = createMemoryStore();
    const ran: string[] = [];
    const { log, lines } = recorder();
    const reports = await runMigrations([step('a', ran), step('b', ran, { fail: true }), step('c', ran)], { store }, log);
    expect(ran).toEqual(['a', 'b']);
    expect(reports).toEqual([{ name: 'a', status: 'done' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'skipped' }]);
    const failed = lines.find((line) => line.level === 'error');
    expect(failed?.fields).toMatchObject({ migration: 'b' });
    expect(failed?.message).toBe('migration failed; the next boot retries it');
    expect(await markerDone(store, '__migrations/b')).toBe(false);
    expect(await markerDone(store, '__migrations/c')).toBe(false);
  });

  it('a "continue" migration that fails lets the next ones run', async () => {
    const store = createMemoryStore();
    const ran: string[] = [];
    const reports = await runMigrations([step('a', ran, { onFailure: 'continue', fail: true }), step('b', ran)], { store }, recorder().log);
    expect(ran).toEqual(['a', 'b']);
    expect(reports.map((report) => report.status)).toEqual(['failed', 'done']);
  });

  it('a "fatal" migration that fails stops the boot with its error, and the later ones do not run', async () => {
    const store = createMemoryStore();
    const ran: string[] = [];
    await expect(runMigrations([step('a', ran, { onFailure: 'fatal', fail: true }), step('b', ran)], { store }, recorder().log)).rejects.toThrow('a broke');
    expect(ran).toEqual(['a']);
  });

  it('a migration that is not applicable here is skipped and leaves no marker, so a later boot with the dependency asks again', async () => {
    const store = createMemoryStore();
    const ran: string[] = [];
    const reports = await runMigrations([step('a', ran, { notApplicable: true })], { store }, recorder().log);
    expect(reports).toEqual([{ name: 'a', status: 'skipped' }]);
    expect(await markerDone(store, '__migrations/a')).toBe(false);
  });
});

describe('the boot registry', () => {
  it('lists the one-off migrations in their order, with the marker ids the live database already has', () => {
    expect(migrations.map((migration) => [migration.name, migration.marker, migration.onFailure ?? 'stop'])).toEqual([
      ['home-files', '__migrations/home-v1', 'fatal'],
      ['identity-backfill', '__migrations/identity-v1', 'continue'],
      ['people-pages', '__migrations/people-pages-v1', 'continue'],
      ['memory-items', '__migrations/memory-items-v2', 'continue'],
      ['owner-person', '__migrations/owner-person-v1', 'continue'],
      ['group-notes', '__migrations/group-notes-v1', 'continue'],
      ['apps', '__migrations/apps-v1', 'continue'],
      ['app-labels', '__migrations/apps-labels-v1', 'continue'],
      ['self-bots', '__migrations/shared-app-only-v1', 'continue'],
    ]);
  });

  it('runs every entry through the runner: without Postgres the ones that need it are not applicable, the others mark themselves done once', async () => {
    const store = createMemoryStore();
    const first = recorder();
    const reports = await runMigrations(migrations, { store }, first.log);
    expect(reports).toEqual([
      { name: 'home-files', status: 'done' },
      { name: 'identity-backfill', status: 'skipped' },
      { name: 'people-pages', status: 'skipped' },
      { name: 'memory-items', status: 'skipped' },
      { name: 'owner-person', status: 'skipped' },
      { name: 'group-notes', status: 'done' },
      { name: 'apps', status: 'done' },
      { name: 'app-labels', status: 'done' },
      { name: 'self-bots', status: 'done' },
    ]);
    expect(await markerDone(store, '__migrations/home-v1')).toBe(true);
    expect(await markerDone(store, '__migrations/group-notes-v1')).toBe(true);
    expect(await markerDone(store, '__migrations/identity-v1')).toBe(false);

    const second = await runMigrations(migrations, { store }, recorder().log);
    expect(second.map((report) => report.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });
});
