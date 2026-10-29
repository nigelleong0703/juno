/**
 * Exposure: which skill versions a run read (BACKEND §5.15). `skill_read` calls this once per read; the run document keeps
 * `skills: [{skillId, versionId, platform?}]` in first-read order, one entry per version. Reading a skill is exposure, not proof the
 * run followed it, so the nightly outcome labels are correlations with a cheap revert, not causes.
 */
import type { RunSkill } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';

/** Add `skill` to the run's `skills` unless this version is already there. A run that is not stored (a test double) records nothing. */
export async function recordRunSkill(store: Store, runId: string, skill: RunSkill): Promise<void> {
  await store.tx(async (tx) => {
    const run = tx.getForUpdate === undefined ? await tx.get('runs', runId) : await tx.getForUpdate('runs', runId);
    if (run === null) return;
    const seen = run.skills ?? [];
    if (seen.some((entry) => entry.versionId === skill.versionId)) return;
    await tx.patch('runs', runId, { skills: [...seen, skill] });
  });
}
