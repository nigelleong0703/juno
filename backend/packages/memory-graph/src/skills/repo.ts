/**
 * Raw SQL for skill definitions and versions (migration 0049). Every statement filters on owner_id. DurableDb passes strings, numbers and
 * null only, so jsonb is written as JSON text and cast in SQL (`?::text::jsonb`), and reads come back as parsed values or text (both handled).
 */
import type { DurableDb } from '@agent-desktop/durable';
import type { SkillDef, SkillDep, SkillOrigin, SkillScope, SkillStatus, SkillVersion, SkillView } from './types.js';

type Stamp = Date | string;

export interface DefRow {
  id: string;
  owner_id: string;
  scope: string;
  agent_id: string | null;
  slug: string;
  active_version_id: string | null;
  created_at: Stamp;
}

export interface VersionRow {
  id: string;
  owner_id: string;
  skill_id: string;
  version: number;
  status: string;
  name: string;
  description: string;
  instructions: string;
  deps: unknown;
  origin: string;
  used: number;
  helpful: number;
  harmful: number;
  last_used_at: Stamp | null;
  created_by: string | null;
  created_at: Stamp;
}

/** A definition left-joined to its active version: `v_*` columns are null when the pointer is empty. */
interface ViewRow extends DefRow {
  v_id: string | null;
  v_owner_id: string | null;
  v_skill_id: string | null;
  v_version: number | null;
  v_status: string | null;
  v_name: string | null;
  v_description: string | null;
  v_instructions: string | null;
  v_deps: unknown;
  v_origin: string | null;
  v_used: number | null;
  v_helpful: number | null;
  v_harmful: number | null;
  v_last_used_at: Stamp | null;
  v_created_by: string | null;
  v_created_at: Stamp | null;
}

const iso = (value: Stamp): string => (value instanceof Date ? value : new Date(value)).toISOString();
const isoOrNull = (value: Stamp | null): string | null => (value === null ? null : iso(value));

/** A dep list as stored: an array of tool / connector objects. Anything else reads as no deps rather than failing the skill. */
export function toDeps(raw: unknown): SkillDep[] {
  const parsed: unknown = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  const out: SkillDep[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (item['type'] === 'tool' && typeof item['name'] === 'string') {
      out.push({ type: 'tool', name: item['name'], schemaHash: typeof item['schemaHash'] === 'string' ? item['schemaHash'] : null });
    } else if (item['type'] === 'connector' && typeof item['catalogId'] === 'string') {
      out.push({ type: 'connector', catalogId: item['catalogId'] });
    }
  }
  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toDef(row: DefRow): SkillDef {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scope: row.scope as SkillScope,
    agentId: row.agent_id,
    slug: row.slug,
    activeVersionId: row.active_version_id,
    createdAt: iso(row.created_at),
  };
}

export function toVersion(row: VersionRow): SkillVersion {
  return {
    id: row.id,
    ownerId: row.owner_id,
    skillId: row.skill_id,
    version: Number(row.version),
    status: row.status as SkillStatus,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    deps: toDeps(row.deps),
    origin: row.origin as SkillOrigin,
    used: Number(row.used),
    helpful: Number(row.helpful),
    harmful: Number(row.harmful),
    lastUsedAt: isoOrNull(row.last_used_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function toView(row: ViewRow): SkillView {
  const def = toDef(row);
  if (row.v_id === null || row.v_skill_id === null) return { def, active: null };
  const version: VersionRow = {
    id: row.v_id,
    owner_id: row.v_owner_id ?? row.owner_id,
    skill_id: row.v_skill_id,
    version: row.v_version ?? 0,
    status: row.v_status ?? 'active',
    name: row.v_name ?? '',
    description: row.v_description ?? '',
    instructions: row.v_instructions ?? '',
    deps: row.v_deps,
    origin: row.v_origin ?? 'manual',
    used: row.v_used ?? 0,
    helpful: row.v_helpful ?? 0,
    harmful: row.v_harmful ?? 0,
    last_used_at: row.v_last_used_at,
    created_by: row.v_created_by,
    created_at: row.v_created_at ?? row.created_at,
  };
  return { def, active: toVersion(version) };
}

/** The view select: a definition with its active version. Callers add the WHERE and ORDER BY. */
const VIEW_SELECT = `
  SELECT d.id, d.owner_id, d.scope, d.agent_id, d.slug, d.active_version_id, d.created_at,
         v.id AS v_id, v.owner_id AS v_owner_id, v.skill_id AS v_skill_id, v.version AS v_version, v.status AS v_status,
         v.name AS v_name, v.description AS v_description, v.instructions AS v_instructions, v.deps AS v_deps,
         v.origin AS v_origin, v.used AS v_used, v.helpful AS v_helpful, v.harmful AS v_harmful,
         v.last_used_at AS v_last_used_at, v.created_by AS v_created_by, v.created_at AS v_created_at
  FROM skill_defs d
  LEFT JOIN skill_versions v ON v.id = d.active_version_id AND v.owner_id = d.owner_id`;

export async function listViews(db: DurableDb, ownerId: string): Promise<SkillView[]> {
  const rows = await db.query<ViewRow>(`${VIEW_SELECT} WHERE d.owner_id = ? ORDER BY d.created_at, d.id`, [ownerId]);
  return rows.map(toView);
}

export async function viewById(db: DurableDb, ownerId: string, id: string): Promise<SkillView | null> {
  const [row] = await db.query<ViewRow>(`${VIEW_SELECT} WHERE d.owner_id = ? AND d.id = ?`, [ownerId, id]);
  return row === undefined ? null : toView(row);
}

/** The skills an agent may load now: the given ids, active, scope-allowed for this agent. Connector checks are the caller's. */
export async function loadableRows(db: DurableDb, ownerId: string, agentId: string, ids: readonly string[]): Promise<SkillView[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(', ');
  const rows = await db.query<ViewRow>(
    `${VIEW_SELECT} WHERE d.owner_id = ? AND d.id IN (${marks}) AND v.status = 'active' AND (d.scope = 'owner' OR d.agent_id = ?)`,
    [ownerId, ...ids, agentId],
  );
  return rows.map(toView);
}

/** Every owner that has at least one skill definition (the boot-time recheck walks them). */
export async function ownersWithSkills(db: DurableDb): Promise<string[]> {
  const rows = await db.query<{ owner_id: string }>('SELECT DISTINCT owner_id FROM skill_defs ORDER BY owner_id');
  return rows.map((row) => row.owner_id);
}

/** The pointed versions (active or in review) of one owner: what the dependency recheck compares against the tools. */
export async function pointedVersions(db: DurableDb, ownerId: string): Promise<SkillVersion[]> {
  const rows = await db.query<VersionRow>(
    `SELECT v.* FROM skill_versions v JOIN skill_defs d ON d.active_version_id = v.id AND d.owner_id = v.owner_id
     WHERE v.owner_id = ? AND v.status IN ('active', 'review')`,
    [ownerId],
  );
  return rows.map(toVersion);
}

export async function defRow(db: DurableDb, ownerId: string, id: string): Promise<SkillDef | null> {
  const [row] = await db.query<DefRow>('SELECT * FROM skill_defs WHERE owner_id = ? AND id = ?', [ownerId, id]);
  return row === undefined ? null : toDef(row);
}

export async function versionRows(db: DurableDb, ownerId: string, skillId: string): Promise<SkillVersion[]> {
  const rows = await db.query<VersionRow>('SELECT * FROM skill_versions WHERE owner_id = ? AND skill_id = ? ORDER BY version DESC', [ownerId, skillId]);
  return rows.map(toVersion);
}

export async function versionOf(db: DurableDb, ownerId: string, skillId: string, version: number): Promise<SkillVersion | null> {
  const [row] = await db.query<VersionRow>('SELECT * FROM skill_versions WHERE owner_id = ? AND skill_id = ? AND version = ?', [ownerId, skillId, version]);
  return row === undefined ? null : toVersion(row);
}

export async function insertDef(db: DurableDb, def: SkillDef): Promise<void> {
  await db.query(
    'INSERT INTO skill_defs (id, owner_id, scope, agent_id, slug, active_version_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    [def.id, def.ownerId, def.scope, def.agentId, def.slug, def.createdAt],
  );
}

export async function insertVersion(db: DurableDb, version: SkillVersion): Promise<void> {
  await db.query(
    `INSERT INTO skill_versions (id, owner_id, skill_id, version, status, name, description, instructions, deps, origin, used, helpful, harmful, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb, ?, 0, 0, 0, ?, ?)`,
    [version.id, version.ownerId, version.skillId, version.version, version.status, version.name, version.description, version.instructions,
      JSON.stringify(version.deps), version.origin, version.createdBy, version.createdAt],
  );
}

export async function setPointer(db: DurableDb, ownerId: string, skillId: string, versionId: string): Promise<void> {
  await db.query('UPDATE skill_defs SET active_version_id = ? WHERE owner_id = ? AND id = ?', [versionId, ownerId, skillId]);
}

export async function setStatus(db: DurableDb, ownerId: string, versionId: string, status: SkillStatus): Promise<void> {
  await db.query('UPDATE skill_versions SET status = ? WHERE owner_id = ? AND id = ?', [status, ownerId, versionId]);
}

/** Rewrite only the dep list (the recheck pins a null schema hash, and an activation clears the pins). Declared names never change. */
export async function setDeps(db: DurableDb, ownerId: string, versionId: string, deps: readonly SkillDep[]): Promise<void> {
  await db.query('UPDATE skill_versions SET deps = ?::text::jsonb WHERE owner_id = ? AND id = ?', [JSON.stringify(deps), ownerId, versionId]);
}

export async function slugTaken(db: DurableDb, ownerId: string, scope: SkillScope, agentId: string | null, slug: string): Promise<boolean> {
  const rows = scope === 'owner'
    ? await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM skill_defs WHERE owner_id = ? AND scope = 'owner' AND slug = ?", [ownerId, slug])
    : await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM skill_defs WHERE owner_id = ? AND scope = 'agent' AND agent_id = ? AND slug = ?", [ownerId, agentId ?? '', slug]);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** A counter bump on one version. The column is fixed by the caller (never user input). */
export async function bump(db: DurableDb, ownerId: string, versionId: string, column: 'used' | 'helpful' | 'harmful'): Promise<void> {
  const touch = column === 'used' ? ', last_used_at = NOW()' : '';
  await db.query(`UPDATE skill_versions SET ${column} = ${column} + 1${touch} WHERE owner_id = ? AND id = ?`, [ownerId, versionId]);
}
