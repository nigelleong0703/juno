/**
 * Skill fixtures (package export `./testing`): a skill written straight to the tables under the id the test chooses, with its version 1
 * active. Tests use it where they need readable ids; production writes go through the skill service (`createSkillsService`).
 */
import type { DurableDb } from '@agent-desktop/durable';
import * as repo from '../skills/repo.js';
import type { SkillDep } from '../skills/types.js';

export interface SkillSeed {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  deps?: SkillDep[];
  /** Set for an agent-scoped skill. */
  agentId?: string;
}

export async function seedSkill(db: DurableDb, ownerId: string, seed: SkillSeed): Promise<void> {
  const now = new Date().toISOString();
  const agentId = seed.agentId ?? null;
  await repo.insertDef(db, { id: seed.id, ownerId, scope: agentId === null ? 'owner' : 'agent', agentId, slug: seed.id, activeVersionId: null, createdAt: now });
  const versionId = 'skv-' + seed.id;
  await repo.insertVersion(db, {
    id: versionId, ownerId, skillId: seed.id, version: 1, status: 'active', name: seed.name, description: seed.description ?? '',
    instructions: seed.instructions, deps: seed.deps ?? [], origin: 'manual', used: 0, helpful: 0, harmful: 0, lastUsedAt: null, createdBy: null, createdAt: now,
  });
  await repo.setPointer(db, ownerId, seed.id, versionId);
}
