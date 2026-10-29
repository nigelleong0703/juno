/**
 * An in-memory skill service for unit tests: the same `SkillsService` interface, with the rules the Postgres store enforces for a read
 * (owner scope, active status, agent scope, connectors connected). The SQL itself is tested against a real Postgres in memory-graph and db.
 * Methods a unit test does not use throw, so a test that starts relying on them fails loudly.
 */
import type { LoadableSkill, SkillDep, SkillStatus, SkillVersion, SkillView, SkillsService } from '@agent-desktop/memory-graph/skills';

export interface FakeSkill {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  ownerId: string;
  /** Set for an agent-scoped skill. */
  agentId?: string;
  deps?: SkillDep[];
  status?: SkillStatus;
}

const NOW = '2026-10-08T00:00:00.000Z';

function viewOf(skill: FakeSkill): SkillView {
  const version: SkillVersion = {
    id: 'skv-' + skill.id, ownerId: skill.ownerId, skillId: skill.id, version: 1, status: skill.status ?? 'active',
    name: skill.name, description: skill.description ?? '', instructions: skill.instructions, deps: skill.deps ?? [], origin: 'manual',
    used: 0, helpful: 0, harmful: 0, lastUsedAt: null, createdBy: null, createdAt: NOW,
  };
  const agentId = skill.agentId ?? null;
  return {
    def: { id: skill.id, ownerId: skill.ownerId, scope: agentId === null ? 'owner' : 'agent', agentId, slug: skill.id, activeVersionId: version.id, createdAt: NOW },
    active: version,
  };
}

const notUsed = (method: string) => (): never => {
  throw new Error('the fake skill service does not implement ' + method);
};

/** A skill service over the given skills; `uses` counts recorded reads per version id, for asserting skill_read counts a use. */
export function createFakeSkills(skills: readonly FakeSkill[]): SkillsService & { uses: Map<string, number> } {
  const uses = new Map<string, number>();
  const views = skills.map(viewOf);
  const visibleTo = (ownerId: string, agentId: string | null): SkillView[] =>
    views.filter((view) => view.def.ownerId === ownerId && (view.def.scope === 'owner' || view.def.agentId === agentId));
  return {
    uses,
    async list(ownerId) {
      return visibleTo(ownerId, null);
    },
    async get(ownerId, id) {
      return views.find((view) => view.def.ownerId === ownerId && view.def.id === id) ?? null;
    },
    async exists(ownerId, id) {
      return views.some((view) => view.def.ownerId === ownerId && view.def.id === id);
    },
    async loadable(ownerId, agentId, skillIds, connected): Promise<LoadableSkill[]> {
      const out: LoadableSkill[] = [];
      for (const id of [...new Set(skillIds)]) {
        const view = views.find((candidate) => candidate.def.ownerId === ownerId && candidate.def.id === id);
        const active = view?.active;
        if (view === undefined || active === undefined || active === null || active.status !== 'active') continue;
        if (view.def.scope === 'agent' && view.def.agentId !== agentId) continue;
        const ready = active.deps.every((dep) => dep.type !== 'connector' || connected.has(dep.catalogId));
        if (!ready) continue;
        out.push({ id, versionId: active.id, version: active.version, name: active.name, description: active.description, instructions: active.instructions });
      }
      return out;
    },
    async recordUse(_ownerId, versionId) {
      uses.set(versionId, (uses.get(versionId) ?? 0) + 1);
    },
    recordOutcome: notUsed('recordOutcome'),
    create: notUsed('create'),
    edit: notUsed('edit'),
    versions: notUsed('versions'),
    activate: notUsed('activate'),
    rollback: notUsed('rollback'),
    async recheck() {
      return { pinned: 0, reviewed: [] };
    },
    async recheckAll() {
      return { pinned: 0, reviewed: [] };
    },
  };
}
