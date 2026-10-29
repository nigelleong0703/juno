/**
 * Skill lifecycle over the repo (memory-graph design §7): create, edit (a new version), activate, roll back, the dependency recheck, and the
 * selection an agent may load. Owner-scoped: every method takes the owner id and only ever reads or writes that owner's rows.
 *
 * Rules the rest of the system relies on:
 * - a version's text, name and declared deps never change; the only writes to a version are its status, its counters and the pinned hash
 *   of a tool dep (null until first seen, then set once; activation clears it so the owner's accepted schema is pinned again);
 * - an edit always makes a new version and moves the pointer, so the previous version stays as the rollback target;
 * - `review` (a tool's schema changed) is not loaded until the owner activates the skill or rolls back; a disconnected connector means
 *   the skill is not loaded now, but its status is left alone (the connector coming back restores it);
 * - a skill cannot grant permissions: this module never reads a skill's text for any decision, only the stored status and deps.
 */
import { randomUUID } from 'node:crypto';
import type { DurableDb } from '@agent-desktop/durable';
import * as repo from './repo.js';
import { validateSkillText } from './validate.js';
import {
  SkillError,
  type LoadableSkill,
  type NewSkillInput,
  type RecheckReport,
  type SkillDep,
  type SkillDepInput,
  type SkillVersion,
  type SkillView,
  type ToolHashes,
} from './types.js';

/** Bounds: a skill declares at most this many deps, and one selection read looks at most this many ids. */
export const MAX_DEPS = 32;
export const MAX_SELECTED_IDS = 200;

export interface SkillsService {
  list(ownerId: string): Promise<SkillView[]>;
  get(ownerId: string, id: string): Promise<SkillView | null>;
  /** True when the owner has this skill definition (any pointer state): the check for an agent's selection. */
  exists(ownerId: string, id: string): Promise<boolean>;
  create(ownerId: string, input: NewSkillInput, createdBy?: string): Promise<SkillView>;
  /** A content change: a new active version; the previous active one becomes `retired`. */
  edit(ownerId: string, id: string, input: NewSkillInput, createdBy?: string): Promise<SkillView>;
  versions(ownerId: string, id: string): Promise<SkillVersion[]>;
  /** Move the pointer to version `version`; this is also how an owner accepts a skill in `review`. */
  activate(ownerId: string, id: string, version: number): Promise<SkillView>;
  /** Move the pointer to the newest retired version older than the active one. */
  rollback(ownerId: string, id: string): Promise<SkillView>;
  /** The skills of `skillIds` this agent may load now (active, scope allowed, connectors connected), in the given order. */
  loadable(ownerId: string, agentId: string, skillIds: readonly string[], connected: ReadonlySet<string>): Promise<LoadableSkill[]>;
  recordUse(ownerId: string, versionId: string): Promise<void>;
  /** The hook for helpful / harmful counts: a later learning batch decides when to call it. */
  recordOutcome(ownerId: string, versionId: string, outcome: 'helpful' | 'harmful'): Promise<void>;
  /** Compare each pointed version's tool deps with the current tools: pin unseen hashes, move a changed one to `review`. */
  recheck(ownerId: string, tools: ToolHashes): Promise<RecheckReport>;
  /** The boot-time recheck of every owner that has skills. */
  recheckAll(tools: ToolHashes): Promise<RecheckReport>;
}

const emptyReport = (): RecheckReport => ({ pinned: 0, reviewed: [] });

/** The stored dep for a written one: a tool dep is unpinned (null), a connector dep keeps its catalog id. */
export function depsFromInput(input: readonly SkillDepInput[]): SkillDep[] {
  if (input.length > MAX_DEPS) throw new SkillError('SKILL_INVALID', 'A skill declares at most ' + String(MAX_DEPS) + ' dependencies.');
  const seen = new Set<string>();
  const out: SkillDep[] = [];
  for (const dep of input) {
    const key = dep.type === 'tool' ? 'tool:' + dep.name : 'connector:' + dep.catalogId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep.type === 'tool' ? { type: 'tool', name: dep.name, schemaHash: null } : { type: 'connector', catalogId: dep.catalogId });
  }
  return out;
}

function slugOf(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'skill' : slug.slice(0, 60);
}

/** A slug unused in the scope: the name's slug, then with a number, then with a random tail. */
async function freeSlug(db: DurableDb, ownerId: string, input: NewSkillInput): Promise<string> {
  const scope = input.agentId === undefined ? 'owner' : 'agent';
  const base = slugOf(input.name);
  for (let n = 1; n <= 20; n += 1) {
    const candidate = n === 1 ? base : base + '-' + String(n);
    if (!(await repo.slugTaken(db, ownerId, scope, input.agentId ?? null, candidate))) return candidate;
  }
  return base + '-' + randomUUID().slice(0, 8);
}

function versionFields(input: NewSkillInput) {
  return { name: input.name.trim(), description: input.description.trim(), instructions: input.instructions.trim(), deps: depsFromInput(input.deps) };
}

async function requireView(db: DurableDb, ownerId: string, id: string): Promise<SkillView> {
  const view = await repo.viewById(db, ownerId, id);
  if (view === null) throw new SkillError('SKILL_NOT_FOUND', 'No skill ' + id + '.');
  return view;
}

/** Clear the pinned hashes of a version's tool deps: accepting a version re-pins it against the tools as they are now. */
function unpinned(deps: readonly SkillDep[]): SkillDep[] {
  return deps.map((dep) => (dep.type === 'tool' ? { ...dep, schemaHash: null } : dep));
}

export function createSkillsService(db: DurableDb): SkillsService {
  const activateIn = async (tx: DurableDb, ownerId: string, id: string, version: number): Promise<SkillView> => {
    const def = await repo.defRow(tx, ownerId, id);
    if (def === null) throw new SkillError('SKILL_NOT_FOUND', 'No skill ' + id + '.');
    const target = await repo.versionOf(tx, ownerId, id, version);
    if (target === null) throw new SkillError('SKILL_VERSION_NOT_FOUND', 'Skill ' + id + ' has no version ' + String(version) + '.');
    if (def.activeVersionId === target.id && target.status === 'active') return requireView(tx, ownerId, id);
    if (def.activeVersionId !== null && def.activeVersionId !== target.id) await repo.setStatus(tx, ownerId, def.activeVersionId, 'retired');
    await repo.setStatus(tx, ownerId, target.id, 'active');
    if (target.deps.some((dep) => dep.type === 'tool' && dep.schemaHash !== null)) await repo.setDeps(tx, ownerId, target.id, unpinned(target.deps));
    await repo.setPointer(tx, ownerId, id, target.id);
    return requireView(tx, ownerId, id);
  };

  const service: SkillsService = {
    async list(ownerId) {
      return repo.listViews(db, ownerId);
    },

    async get(ownerId, id) {
      return repo.viewById(db, ownerId, id);
    },

    async exists(ownerId, id) {
      return (await repo.defRow(db, ownerId, id)) !== null;
    },

    async create(ownerId, input, createdBy) {
      const fields = versionFields(input);
      validateSkillText(fields);
      return db.transaction(async (tx) => {
        const now = new Date().toISOString();
        const id = 'skl-' + String(Date.now()) + '-' + randomUUID().slice(0, 8);
        const agentId = input.agentId ?? null;
        await repo.insertDef(tx, {
          id, ownerId, scope: agentId === null ? 'owner' : 'agent', agentId, slug: await freeSlug(tx, ownerId, input), activeVersionId: null, createdAt: now,
        });
        const versionId = 'skv-' + randomUUID().slice(0, 12);
        await repo.insertVersion(tx, {
          id: versionId, ownerId, skillId: id, version: 1, status: 'active', origin: 'manual', used: 0, helpful: 0, harmful: 0,
          lastUsedAt: null, createdBy: createdBy ?? null, createdAt: now, ...fields,
        });
        await repo.setPointer(tx, ownerId, id, versionId);
        return requireView(tx, ownerId, id);
      });
    },

    async edit(ownerId, id, input, createdBy) {
      const fields = versionFields(input);
      validateSkillText(fields);
      return db.transaction(async (tx) => {
        const def = await repo.defRow(tx, ownerId, id);
        if (def === null) throw new SkillError('SKILL_NOT_FOUND', 'No skill ' + id + '.');
        const existing = await repo.versionRows(tx, ownerId, id);
        const next = (existing[0]?.version ?? 0) + 1;
        if (def.activeVersionId !== null) await repo.setStatus(tx, ownerId, def.activeVersionId, 'retired');
        const versionId = 'skv-' + randomUUID().slice(0, 12);
        await repo.insertVersion(tx, {
          id: versionId, ownerId, skillId: id, version: next, status: 'active', origin: 'manual', used: 0, helpful: 0, harmful: 0,
          lastUsedAt: null, createdBy: createdBy ?? null, createdAt: new Date().toISOString(), ...fields,
        });
        await repo.setPointer(tx, ownerId, id, versionId);
        return requireView(tx, ownerId, id);
      });
    },

    async versions(ownerId, id) {
      if ((await repo.defRow(db, ownerId, id)) === null) throw new SkillError('SKILL_NOT_FOUND', 'No skill ' + id + '.');
      return repo.versionRows(db, ownerId, id);
    },

    async activate(ownerId, id, version) {
      return db.transaction((tx) => activateIn(tx, ownerId, id, version));
    },

    async rollback(ownerId, id) {
      return db.transaction(async (tx) => {
        const view = await requireView(tx, ownerId, id);
        const current = view.active?.version ?? 0;
        const previous = (await repo.versionRows(tx, ownerId, id))
          .filter((row) => row.status === 'retired' && row.version < current)
          .sort((a, b) => b.version - a.version)[0];
        if (previous === undefined) throw new SkillError('SKILL_NO_PREVIOUS_VERSION', 'Skill ' + id + ' has no earlier version to roll back to.');
        return activateIn(tx, ownerId, id, previous.version);
      });
    },

    async loadable(ownerId, agentId, skillIds, connected) {
      const ids = [...new Set(skillIds)].slice(0, MAX_SELECTED_IDS);
      const rows = await repo.loadableRows(db, ownerId, agentId, ids);
      const order = new Map(ids.map((id, index) => [id, index]));
      const out: LoadableSkill[] = [];
      for (const view of rows) {
        const active = view.active;
        if (active === null) continue;
        const connectorsReady = active.deps.every((dep) => dep.type !== 'connector' || connected.has(dep.catalogId));
        if (!connectorsReady) continue;
        out.push({ id: view.def.id, versionId: active.id, version: active.version, name: active.name, description: active.description, instructions: active.instructions });
      }
      return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    },

    async recordUse(ownerId, versionId) {
      await repo.bump(db, ownerId, versionId, 'used');
    },

    async recordOutcome(ownerId, versionId, outcome) {
      await repo.bump(db, ownerId, versionId, outcome);
    },

    async recheck(ownerId, tools) {
      const report = emptyReport();
      for (const version of await repo.pointedVersions(db, ownerId)) {
        let changedTool: string | undefined;
        let pinnedHere = false;
        const deps = version.deps.map((dep): SkillDep => {
          if (dep.type !== 'tool') return dep;
          const current = tools(dep.name);
          if (current === undefined) return dep;
          if (dep.schemaHash === null) {
            pinnedHere = true;
            report.pinned += 1;
            return { ...dep, schemaHash: current };
          }
          if (dep.schemaHash !== current && changedTool === undefined) changedTool = dep.name;
          return dep;
        });
        if (pinnedHere) await repo.setDeps(db, ownerId, version.id, deps);
        if (changedTool !== undefined && version.status === 'active') {
          await repo.setStatus(db, ownerId, version.id, 'review');
          report.reviewed.push({ skillId: version.skillId, version: version.version, tool: changedTool });
        }
      }
      return report;
    },

    async recheckAll(tools) {
      const report = emptyReport();
      for (const ownerId of await repo.ownersWithSkills(db)) {
        const part = await service.recheck(ownerId, tools);
        report.pinned += part.pinned;
        report.reviewed.push(...part.reviewed);
      }
      return report;
    },
  };
  return service;
}
