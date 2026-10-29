/**
 * The one-off data migrations that run at agentd boot. Each migration is one entry (see `registry.ts`): it has a marker row under the
 * system owner once it has run, and the entries run in order. A migration writes its own marker where it always has (the marker's place
 * matters for some of them), so a run that stops early is finished by the next boot.
 */
import { getRow } from 'juno-agent/modules/home/mirror';
import type { Store } from 'juno-agent/contracts';

/** What a failure does to the rest of the boot. `stop` (the default): log it and skip the later migrations; boot goes on. `continue`: log it and run the next one. `fatal`: log it and fail the boot. */
export type FailurePolicy = 'stop' | 'continue' | 'fatal';

export interface MigrationOutcome {
  /** True when there was nothing to do (not applicable to this deployment, or already done). */
  skipped: boolean;
  /** What the run did, logged with the done line. */
  counts?: Record<string, number>;
}

export interface Migration<D extends { store: Store }> {
  /** The name in the log lines. */
  name: string;
  /** The marker row's path under the system owner: present once the migration has run. */
  marker: string;
  onFailure?: FailurePolicy;
  run(deps: D): Promise<MigrationOutcome>;
}

export interface MigrationLog {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type MigrationStatus = 'done' | 'skipped' | 'failed';

export interface MigrationReport {
  name: string;
  status: MigrationStatus;
}

/**
 * Runs the migrations in order and returns one report per entry. A marked migration is skipped without running. A failure is logged
 * with the migration's name; then `onFailure` decides what happens to the rest.
 */
export async function runMigrations<D extends { store: Store }>(migrations: readonly Migration<D>[], deps: D, log: MigrationLog): Promise<MigrationReport[]> {
  const reports: MigrationReport[] = [];
  let halted: string | undefined;
  for (const migration of migrations) {
    const { name } = migration;
    if (halted !== undefined) {
      log.info({ migration: name, after: halted }, 'migration skipped: an earlier migration failed');
      reports.push({ name, status: 'skipped' });
      continue;
    }
    if ((await getRow(deps.store, 'system', migration.marker)) !== null) {
      log.info({ migration: name }, 'migration skipped: already done');
      reports.push({ name, status: 'skipped' });
      continue;
    }
    try {
      const outcome = await migration.run(deps);
      if (outcome.skipped) {
        log.info({ migration: name }, 'migration skipped: not applicable here');
        reports.push({ name, status: 'skipped' });
      } else {
        log.info({ migration: name, ...outcome.counts }, 'migration done');
        reports.push({ name, status: 'done' });
      }
    } catch (error) {
      log.error({ err: error, migration: name }, 'migration failed; the next boot retries it');
      reports.push({ name, status: 'failed' });
      const policy = migration.onFailure ?? 'stop';
      if (policy === 'fatal') throw error;
      if (policy === 'stop') halted = name;
    }
  }
  return reports;
}
