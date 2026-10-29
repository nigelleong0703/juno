/**
 * The boot's one-off data migrations, in the order they run. Adding one: write it in its module (with a marker row), then add one entry
 * here. Never reorder or rename an entry: its marker row is its identity on the live database.
 */
import type { DurableDb } from '@agent-desktop/durable';
import type { Identity } from '@agent-desktop/memory-graph/identity';
import type { Store } from 'juno-agent/contracts';
import { MARKER as HOME_MARKER, migrateHomeFiles } from 'juno-agent/modules/home/migrate';
import { MARKER as GROUP_MARKER, migrateGroupNotes } from 'juno-agent/modules/groups/migrate';
import { MARKER as MEMORY_ITEMS_MARKER, migrateMemoryItems } from 'juno-agent/modules/memory/migrate';
import type { MemoryGraph } from 'juno-agent/modules/memory/graph';
import { BACKFILL_MARKER as OWNER_MARKER, backfillOwnerPeople } from 'juno-agent/modules/memory/owner';
import { MIGRATION_MARKER as PEOPLE_MARKER, migratePeoplePages } from 'juno-agent/modules/people/pages';
import { BACKFILL_MARKER as IDENTITY_MARKER, backfillPeople } from '../channels/people.js';
import { MARKER as SELF_BOTS_MARKER, migrateSelfBots } from '../channels/self-bots.js';
import { MARKER as APPS_MARKER, migrateApps } from '../apps/migrate.js';
import { backfillLabels, LABELS_MARKER } from '../apps/labels.js';
import type { Migration } from './runner.js';

/** What the migrations read. The identity and memory parts exist only with Postgres; a migration that needs one is not applicable without it. */
export interface MigrationDeps {
  store: Store;
  raw?: DurableDb;
  identity?: Identity;
  memory?: MemoryGraph;
}

export const migrations: readonly Migration<MigrationDeps>[] = [
  {
    // Agent texts and aboutMe move into home files. A failure here has always failed the boot, and still does.
    name: 'home-files',
    marker: HOME_MARKER,
    onFailure: 'fatal',
    run: async ({ store }) => ({ skipped: false, counts: { rows: await migrateHomeFiles(store) } }),
  },
  {
    name: 'identity-backfill',
    marker: IDENTITY_MARKER,
    onFailure: 'continue',
    run: async ({ store, raw, identity }) => {
      if (raw === undefined || identity === undefined) return { skipped: true };
      const counts = await backfillPeople({ store, raw, identity });
      return { skipped: counts.skipped, counts: { owners: counts.owners, items: counts.items, senders: counts.senders } };
    },
  },
  {
    name: 'people-pages',
    marker: PEOPLE_MARKER,
    onFailure: 'continue',
    run: async ({ store, identity }) => {
      const pages = await migratePeoplePages({ store, ...(identity === undefined ? {} : { identity }) });
      return { skipped: pages.skipped, counts: { pages: pages.moved } };
    },
  },
  {
    name: 'memory-items',
    marker: MEMORY_ITEMS_MARKER,
    onFailure: 'continue',
    run: async ({ store, memory }) => {
      if (memory === undefined) return { skipped: true };
      const items = await migrateMemoryItems({ store, memory });
      return { skipped: items.skipped, counts: { migrated: items.migrated, reviewed: items.reviewed, fixed: items.fixed } };
    },
  },
  {
    name: 'owner-person',
    marker: OWNER_MARKER,
    onFailure: 'continue',
    run: async ({ store, memory }) => {
      if (memory === undefined) return { skipped: true };
      const owners = await backfillOwnerPeople(store, memory);
      return { skipped: owners.skipped, counts: { owners: owners.owners } };
    },
  },
  {
    name: 'group-notes',
    marker: GROUP_MARKER,
    onFailure: 'continue',
    run: async ({ store }) => {
      const notes = await migrateGroupNotes(store);
      return { skipped: notes.skipped, counts: { merged: notes.merged, archived: notes.archived } };
    },
  },
  {
    // Connection permission levels become per-agent Actions policies; each Slack workspace keeps the main agent's row (BACKEND 10.18).
    name: 'apps',
    marker: APPS_MARKER,
    onFailure: 'continue',
    run: async ({ store }) => {
      const apps = await migrateApps(store);
      return { skipped: apps.skipped, counts: { policies: apps.policies, stripped: apps.stripped, dmRows: apps.dmRows } };
    },
  },
  {
    // The Discord server / Slack workspace / Feishu app names the Apps page shows, asked of each platform once for rows made before it.
    name: 'app-labels',
    marker: LABELS_MARKER,
    onFailure: 'continue',
    run: async ({ store }) => {
      const labels = await backfillLabels(store);
      return { skipped: labels.skipped, counts: { named: labels.named, failed: labels.failed } };
    },
  },
  {
    // Slack and Discord connect only through the shared Juno app: a row made with the agent's own bot is switched off and shows "reconnect" (channels/self-bots.ts).
    name: 'self-bots',
    marker: SELF_BOTS_MARKER,
    onFailure: 'continue',
    run: async ({ store }) => {
      const bots = await migrateSelfBots(store);
      return { skipped: bots.skipped, counts: { disabled: bots.disabled } };
    },
  },
];
