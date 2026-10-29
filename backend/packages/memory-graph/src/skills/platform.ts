/**
 * Platform skills as versioned rows (migration 0051, BACKEND §5.15): the skills every agent has, seeded from the image's SKILL.md files,
 * changed afterwards only by the line-operation patch API, served as a canary next to the active version, promoted or rolled back by the
 * Wilson rules in evolve.ts. The tables hold no owner data. Exposure counters (`used`) are bumped when a run reads a version; the nightly
 * outcome labels bump `helpful` / `harmful`. The text of a version never changes after it is written.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DurableDb } from '@agent-desktop/durable';
import { EXPIRED_TOMBSTONE_DAYS, MAX_OPS_PER_SKILL_PER_NIGHT, canaryServes, judgeCandidate, wilson } from './evolve.js';
import { applyLineOps, opHash, type LineOp } from './patch.js';
import { SkillError } from './types.js';

export type PlatformStatus = 'candidate' | 'active' | 'retired';
export type CandidateDecision = 'promoted' | 'rolled_back' | 'expired' | 'superseded';

export interface PlatformSkillVersion {
  id: string;
  skillId: string;
  version: number;
  status: PlatformStatus;
  origin: 'seed' | 'learned';
  name: string;
  description: string;
  instructions: string;
  baseVersionId: string | null;
  ops: LineOp[];
  used: number;
  helpful: number;
  harmful: number;
  baseHelpful: number;
  baseHarmful: number;
  lastUsedAt: string | null;
  decision: CandidateDecision | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface PlatformSkillFile {
  /** The directory name in the image. */
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** sha256 of the file the other fields were read from. */
  hash: string;
  /** 'image' (default) or 'app:<appId>' for a catalog app's skill pack. Only a file of the same source may change an existing row. */
  source?: string;
}

/** Who is reading: the owner and agent of the run, for the source condition of non-image skills. */
export interface SkillReader {
  ownerId: string;
  agentId: string;
}

/**
 * Whether a skill of this source may be loaded for this reader. Image skills never ask: they are always available. The apps module supplies
 * the check for `app:<appId>` (the owner added that app and enabled it for the agent); with no check, app skills are not available to anyone.
 */
export type SourceGate = (source: string, reader: SkillReader) => boolean | Promise<boolean>;

/** What a run reads: the version it was served (the candidate for a canary run) and which. */
export interface ResolvedPlatformSkill {
  skillId: string;
  source: string;
  versionId: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  canary: boolean;
}

export interface SeedReport {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface CandidateReview {
  skillId: string;
  versionId: string;
  decision: 'promote' | 'rollback' | 'expire' | 'wait';
  reason: string;
}

export interface VersionMetrics {
  versionId: string;
  version: number;
  status: PlatformStatus;
  origin: 'seed' | 'learned';
  exposures: number;
  good: number;
  bad: number;
  /** good + bad: the exposures that got a label (unknown outcomes are neither). */
  labeled: number;
  badRate: number;
  badRateLow: number;
  badRateHigh: number;
  opCount: number;
  decision: CandidateDecision | null;
  createdAt: string;
}

export interface SkillMetrics {
  source: string;
  skillId: string;
  name: string;
  activeVersionId: string | null;
  versions: VersionMetrics[];
}

export interface PlatformSkillsService {
  /** Every active image skill's metadata, ordered by name then id, with no cap (the prompt applies its own budget); no bodies, canaries, app packs or exposure writes. Optional for legacy adapters. */
  catalog?(): Promise<Array<{ name: string; description: string }>>;
  /** Make the table match the image's files: new skills are created, a changed file becomes a new seed version, an unchanged one is left alone. */
  seed(files: readonly PlatformSkillFile[]): Promise<SeedReport>;
  /** The version a run reads for a skill named by its id or its name: the active one, or the candidate for the canary share of runs. Null: no such skill. */
  resolve(name: string, runId: string, reader?: SkillReader): Promise<ResolvedPlatformSkill | null>;
  recordUse(versionId: string): Promise<void>;
  recordOutcome(versionId: string, outcome: 'helpful' | 'harmful'): Promise<void>;
  /** The active version of a skill, or null. */
  active(skillId: string): Promise<PlatformSkillVersion | null>;
  /** Whether the skill has a candidate in flight. */
  hasCandidate(skillId: string): Promise<boolean>;
  /** A new candidate version made from the active one by line operations (all or nothing); refused while one is in flight. */
  propose(skillId: string, ops: readonly unknown[], now?: Date): Promise<PlatformSkillVersion>;
  /** Judge every candidate: promote, roll back (tombstoning its operations), expire, or leave it. */
  reviewCandidates(now?: Date): Promise<CandidateReview[]>;
  /** Whether an operation was rolled back (or expired recently) for this skill, so it is not proposed again. */
  isTombstoned(skillId: string, op: LineOp, now?: Date): Promise<boolean>;
  metrics(): Promise<SkillMetrics[]>;
}

interface VersionRow {
  id: string;
  skill_id: string;
  version: number;
  status: string;
  origin: string;
  name: string;
  description: string;
  instructions: string;
  base_version_id: string | null;
  ops: unknown;
  used: number;
  helpful: number;
  harmful: number;
  base_helpful: number;
  base_harmful: number;
  last_used_at: Date | string | null;
  decision: string | null;
  decided_at: Date | string | null;
  created_at: Date | string;
}

interface SkillRow {
  id: string;
  name: string;
  active_version_id: string | null;
  seed_hash: string;
  source: string;
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

function toOps(raw: unknown): LineOp[] {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as LineOp[]) : [];
}

function toVersion(row: VersionRow): PlatformSkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: Number(row.version),
    status: row.status as PlatformStatus,
    origin: row.origin as 'seed' | 'learned',
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    baseVersionId: row.base_version_id,
    ops: toOps(row.ops),
    used: Number(row.used),
    helpful: Number(row.helpful),
    harmful: Number(row.harmful),
    baseHelpful: Number(row.base_helpful),
    baseHarmful: Number(row.base_harmful),
    lastUsedAt: row.last_used_at === null ? null : iso(row.last_used_at),
    decision: row.decision as CandidateDecision | null,
    decidedAt: row.decided_at === null ? null : iso(row.decided_at),
    createdAt: iso(row.created_at),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const slugOf = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** SKILL.md as the image ships it: optional `---` frontmatter with name and description, then the body. */
export function parsePlatformSkillFile(id: string, content: string): PlatformSkillFile | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  const header = match?.[1] ?? '';
  const body = (match?.[2] ?? content).trim();
  if (body === '') return null;
  const field = (key: string): string => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header)?.[1]?.trim() ?? '';
  return {
    id,
    name: field('name') || id,
    description: field('description'),
    instructions: body,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}

export function createPlatformSkillsService(db: DurableDb, options: { gate?: SourceGate } = {}): PlatformSkillsService {
  const versionsOf = async (q: DurableDb, skillId: string): Promise<PlatformSkillVersion[]> =>
    (await q.query<VersionRow>('SELECT * FROM platform_skill_versions WHERE skill_id = ? ORDER BY version DESC', [skillId])).map(toVersion);

  const insertVersion = async (q: DurableDb, row: PlatformSkillVersion): Promise<void> => {
    await q.query(
      `INSERT INTO platform_skill_versions (id, skill_id, version, status, origin, name, description, instructions, base_version_id, ops, base_helpful, base_harmful, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb, ?, ?, ?)`,
      [row.id, row.skillId, row.version, row.status, row.origin, row.name, row.description, row.instructions, row.baseVersionId, JSON.stringify(row.ops),
        row.baseHelpful, row.baseHarmful, row.createdAt],
    );
  };

  const newVersion = (skillId: string, version: number, fields: Pick<PlatformSkillVersion, 'status' | 'origin' | 'name' | 'description' | 'instructions' | 'baseVersionId' | 'ops' | 'baseHelpful' | 'baseHarmful'>, now: Date): PlatformSkillVersion => ({
    id: 'psv-' + randomUUID().slice(0, 12), skillId, version, used: 0, helpful: 0, harmful: 0, lastUsedAt: null, decision: null, decidedAt: null, createdAt: now.toISOString(), ...fields,
  });

  const retire = async (q: DurableDb, versionId: string, decision: CandidateDecision | null, now: Date): Promise<void> => {
    await q.query("UPDATE platform_skill_versions SET status = 'retired', decision = ?, decided_at = ? WHERE id = ?", [decision, decision === null ? null : now.toISOString(), versionId]);
  };

  const tombstone = async (q: DurableDb, skillId: string, ops: readonly LineOp[], reason: string, until: Date | null, now: Date): Promise<void> => {
    for (const op of ops) {
      await q.query(
        `INSERT INTO platform_skill_tombstones (skill_id, op_hash, reason, until, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (skill_id, op_hash) DO UPDATE SET reason = EXCLUDED.reason, until = EXCLUDED.until, created_at = EXCLUDED.created_at`,
        [skillId, opHash(skillId, op), reason, until === null ? null : until.toISOString(), now.toISOString()],
      );
    }
  };

  const isTombstoned = async (q: DurableDb, skillId: string, op: LineOp, now: Date): Promise<boolean> => {
    const rows = await q.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM platform_skill_tombstones WHERE skill_id = ? AND op_hash = ? AND (until IS NULL OR until > ?)',
      [skillId, opHash(skillId, op), now.toISOString()],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  };

  const service: PlatformSkillsService = {
    async catalog() {
      return db.query<{ name: string; description: string }>(
        `SELECT LEFT(v.name, 80) AS name, LEFT(v.description, 240) AS description FROM platform_skills s
         JOIN platform_skill_versions v ON s.active_version_id = v.id AND v.skill_id = s.id
         WHERE s.source = 'image' AND v.status = 'active' ORDER BY v.name, s.id`,
      );
    },

    async seed(files) {
      const report: SeedReport = { created: [], updated: [], unchanged: [] };
      for (const file of files) {
        await db.transaction(async (tx) => {
          const [row] = await tx.query<SkillRow>('SELECT * FROM platform_skills WHERE id = ?', [file.id]);
          const now = new Date();
          const fields = { origin: 'seed' as const, name: file.name, description: file.description, instructions: file.instructions, ops: [], baseHelpful: 0, baseHarmful: 0 };
          if (row === undefined) {
            await tx.query('INSERT INTO platform_skills (id, name, active_version_id, seed_hash, source) VALUES (?, ?, NULL, ?, ?)', [file.id, file.name, file.hash, file.source ?? 'image']);
            const version = newVersion(file.id, 1, { ...fields, status: 'active', baseVersionId: null }, now);
            await insertVersion(tx, version);
            await tx.query('UPDATE platform_skills SET active_version_id = ? WHERE id = ?', [version.id, file.id]);
            report.created.push(file.id);
            return;
          }
          // A file never takes over a row of another source (an image file cannot rewrite an app's pack, or the reverse).
          if (row.seed_hash === file.hash || row.source !== (file.source ?? 'image')) {
            report.unchanged.push(file.id);
            return;
          }
          // The image's file changed (a developer edit): it wins. The old active version and any candidate are retired; their text is kept.
          const versions = await versionsOf(tx, file.id);
          const candidate = versions.find((version) => version.status === 'candidate');
          if (candidate !== undefined) await retire(tx, candidate.id, 'superseded', now);
          if (row.active_version_id !== null) await retire(tx, row.active_version_id, null, now);
          const version = newVersion(file.id, (versions[0]?.version ?? 0) + 1, { ...fields, status: 'active', baseVersionId: row.active_version_id }, now);
          await insertVersion(tx, version);
          await tx.query('UPDATE platform_skills SET active_version_id = ?, name = ?, seed_hash = ? WHERE id = ?', [version.id, file.name, file.hash, file.id]);
          report.updated.push(file.id);
        });
      }
      return report;
    },

    async resolve(name, runId, reader) {
      const key = name.trim().toLowerCase();
      if (key === '') return null;
      const [skill] = await db.query<SkillRow>('SELECT * FROM platform_skills WHERE id = ? OR id = ? OR lower(name) = ? LIMIT 1', [key, slugOf(name), key]);
      if (skill === undefined || skill.active_version_id === null) return null;
      if (skill.source !== 'image' && (options.gate === undefined || reader === undefined || !(await options.gate(skill.source, reader)))) return null;
      const versions = await versionsOf(db, skill.id);
      const active = versions.find((version) => version.id === skill.active_version_id);
      if (active === undefined) return null;
      const candidate = versions.find((version) => version.status === 'candidate');
      const served = candidate !== undefined && canaryServes(runId, skill.id) ? candidate : active;
      return {
        skillId: skill.id, source: skill.source, versionId: served.id, version: served.version, name: served.name, description: served.description,
        instructions: served.instructions, canary: served.id !== active.id,
      };
    },

    async recordUse(versionId) {
      await db.query('UPDATE platform_skill_versions SET used = used + 1, last_used_at = NOW() WHERE id = ?', [versionId]);
    },

    async recordOutcome(versionId, outcome) {
      const column = outcome === 'helpful' ? 'helpful' : 'harmful';
      await db.query(`UPDATE platform_skill_versions SET ${column} = ${column} + 1 WHERE id = ?`, [versionId]);
    },

    async active(skillId) {
      const rows = await db.query<VersionRow>(
        'SELECT v.* FROM platform_skill_versions v JOIN platform_skills s ON s.active_version_id = v.id WHERE s.id = ?', [skillId],
      );
      return rows[0] === undefined ? null : toVersion(rows[0]);
    },

    async hasCandidate(skillId) {
      const rows = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM platform_skill_versions WHERE skill_id = ? AND status = 'candidate'", [skillId]);
      return Number(rows[0]?.n ?? 0) > 0;
    },

    async propose(skillId, ops, now = new Date()) {
      return db.transaction(async (tx) => {
        const [skill] = await tx.query<SkillRow>('SELECT * FROM platform_skills WHERE id = ?', [skillId]);
        if (skill === undefined || skill.active_version_id === null) throw new SkillError('SKILL_NOT_FOUND', 'No platform skill ' + skillId + '.');
        const versions = await versionsOf(tx, skillId);
        if (versions.some((version) => version.status === 'candidate')) throw new SkillError('SKILL_INVALID', 'Skill ' + skillId + ' already has a candidate in flight; one change at a time.');
        const active = versions.find((version) => version.id === skill.active_version_id);
        if (active === undefined) throw new SkillError('SKILL_NOT_FOUND', 'Platform skill ' + skillId + ' has no active version.');
        // The nightly cap counts every operation any version of this skill was made from in the last 24 hours.
        const recent = versions.filter((version) => version.origin === 'learned' && Date.parse(version.createdAt) > now.getTime() - DAY_MS).reduce((sum, version) => sum + version.ops.length, 0);
        if (recent + ops.length > MAX_OPS_PER_SKILL_PER_NIGHT) {
          throw new SkillError('SKILL_INVALID', 'Skill ' + skillId + ' takes at most ' + String(MAX_OPS_PER_SKILL_PER_NIGHT) + ' operations a night.');
        }
        const plan = applyLineOps(active.instructions, ops);
        for (const op of plan.applied) {
          if (await isTombstoned(tx, skillId, op, now)) throw new SkillError('SKILL_INVALID', 'Operation refused: it was rolled back before and is not proposed again.');
        }
        const candidate = newVersion(skillId, (versions[0]?.version ?? 0) + 1, {
          status: 'candidate', origin: 'learned', name: active.name, description: active.description, instructions: plan.text,
          baseVersionId: active.id, ops: plan.applied, baseHelpful: active.helpful, baseHarmful: active.harmful,
        }, now);
        await insertVersion(tx, candidate);
        return candidate;
      });
    },

    async reviewCandidates(now = new Date()) {
      const reviews: CandidateReview[] = [];
      const rows = await db.query<VersionRow>("SELECT * FROM platform_skill_versions WHERE status = 'candidate' ORDER BY created_at");
      for (const candidate of rows.map(toVersion)) {
        await db.transaction(async (tx) => {
          const active = await tx.query<VersionRow>(
            'SELECT v.* FROM platform_skill_versions v JOIN platform_skills s ON s.active_version_id = v.id WHERE s.id = ?', [candidate.skillId],
          ).then((found) => (found[0] === undefined ? null : toVersion(found[0])));
          if (active === null) return;
          const verdict = judgeCandidate(
            { helpful: candidate.helpful, harmful: candidate.harmful, createdAtMs: Date.parse(candidate.createdAt) },
            {
              windowHelpful: Math.max(0, active.helpful - candidate.baseHelpful), windowHarmful: Math.max(0, active.harmful - candidate.baseHarmful),
              helpful: active.helpful, harmful: active.harmful,
            },
            now.getTime(),
          );
          reviews.push({ skillId: candidate.skillId, versionId: candidate.id, ...verdict });
          if (verdict.decision === 'promote') {
            await retire(tx, active.id, null, now);
            await tx.query("UPDATE platform_skill_versions SET status = 'active', decision = 'promoted', decided_at = ? WHERE id = ?", [now.toISOString(), candidate.id]);
            await tx.query('UPDATE platform_skills SET active_version_id = ? WHERE id = ?', [candidate.id, candidate.skillId]);
          } else if (verdict.decision === 'rollback') {
            await retire(tx, candidate.id, 'rolled_back', now);
            await tombstone(tx, candidate.skillId, candidate.ops, verdict.reason, null, now);
          } else if (verdict.decision === 'expire') {
            await retire(tx, candidate.id, 'expired', now);
            await tombstone(tx, candidate.skillId, candidate.ops, verdict.reason, new Date(now.getTime() + EXPIRED_TOMBSTONE_DAYS * DAY_MS), now);
          }
        });
      }
      return reviews;
    },

    async isTombstoned(skillId, op, now = new Date()) {
      return isTombstoned(db, skillId, op, now);
    },

    async metrics() {
      const skills = await db.query<SkillRow>('SELECT * FROM platform_skills ORDER BY id');
      const out: SkillMetrics[] = [];
      for (const skill of skills) {
        const versions = (await versionsOf(db, skill.id)).map((version): VersionMetrics => {
          const labeled = version.helpful + version.harmful;
          const interval = wilson(version.harmful, labeled);
          return {
            versionId: version.id, version: version.version, status: version.status, origin: version.origin, exposures: version.used,
            good: version.helpful, bad: version.harmful, labeled, badRate: interval.rate, badRateLow: interval.low, badRateHigh: interval.high,
            opCount: version.ops.length, decision: version.decision, createdAt: version.createdAt,
          };
        });
        out.push({ skillId: skill.id, source: skill.source, name: skill.name, activeVersionId: skill.active_version_id, versions });
      }
      return out;
    },
  };
  return service;
}
