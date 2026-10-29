/**
 * Platform skills on a real (embedded) Postgres with every migration applied (BACKEND §5.15): seeding from the image's files, the version a
 * run reads (canary), the patch API creating a candidate (never editing a version), promotion, rollback with tombstones, expiry, the
 * one-candidate rule, the nightly cap, and the metrics. Skill ids are unique per test, because the database keeps rows between runs of a file.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import {
  CANARY_PERCENT, PROMOTE_MIN_LABELED, SkillError, canaryServes, createPlatformSkillsService, parsePlatformSkillFile, platformSkillsDir,
  readPlatformSkillFiles, seedPlatformSkills, type PlatformSkillsService,
} from '../index.js';
import { startTestDatabase, type TestDatabase } from '../../testing/index.js';

let database: TestDatabase;
let db: DurableDb;
let platform: PlatformSkillsService;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.db;
  platform = createPlatformSkillsService(db);
}, 240_000);

afterAll(async () => {
  await database?.close();
});

const DAY = 24 * 60 * 60 * 1000;
const slug = (): string => 'sk' + randomUUID().slice(0, 8);
const BODY = ['# Reports', 'Read the sheet first.', 'Write three bullets.', 'Post the draft in the thread.', 'Ask before sending.', 'Keep it short.'].join('\n');
const file = (id: string, body: string = BODY) => parsePlatformSkillFile(id, `---\nname: ${id}\ndescription: Draft reports.\n---\n${body}\n`)!;
const ev = ['run_a'];

async function counters(versionId: string, helpful: number, harmful: number): Promise<void> {
  await db.query('UPDATE platform_skill_versions SET helpful = ?, harmful = ? WHERE id = ?', [helpful, harmful, versionId]);
}

async function seeded(): Promise<string> {
  const id = slug();
  await platform.seed([file(id)]);
  return id;
}

describe('seeding from the image files', () => {
  it('reads every real platform skill, and each one accepts a harmless patch (the seeded text passes validateSkillText)', async () => {
    const files = await readPlatformSkillFiles(platformSkillsDir());
    expect(files.map((item) => item.id)).toEqual(expect.arrayContaining(['pdf', 'docx', 'xlsx', 'pptx']));
    expect(files.some((item) => item.id.startsWith('_'))).toBe(false);
    const pdf = files.find((item) => item.id === 'pdf')!;
    expect(pdf.name).toBe('pdf');
    expect(pdf.description).toMatch(/PDF/);
    expect(pdf.instructions).not.toMatch(/^---/);
    const report = await seedPlatformSkills(platform);
    expect(report.created.length + report.unchanged.length + report.updated.length).toBe(files.length);
    for (const item of files) {
      const view = await platform.resolve(item.id, 'run_seed');
      expect(view?.instructions).toBe(item.instructions);
      const candidate = await platform.propose(item.id, [{ op: 'add_line', line: 'Say what you checked before delivering.', evidence: ev }]);
      expect(candidate.instructions.endsWith('Say what you checked before delivering.')).toBe(true);
      await db.query("UPDATE platform_skill_versions SET status = 'retired' WHERE id = ?", [candidate.id]);
    }
  });

  it('creates once, leaves an unchanged file alone, and a changed file becomes a new seed version that supersedes a candidate', async () => {
    const id = slug();
    expect((await platform.seed([file(id)])).created).toEqual([id]);
    expect((await platform.seed([file(id)])).unchanged).toEqual([id]);
    const candidate = await platform.propose(id, [{ op: 'add_line', line: 'Check the date range.', evidence: ev }]);
    expect(await platform.hasCandidate(id)).toBe(true);
    expect((await platform.seed([file(id, BODY + '\nNew line from the developer.')])).updated).toEqual([id]);
    expect(await platform.hasCandidate(id)).toBe(false);
    const active = await platform.active(id);
    expect(active).toMatchObject({ version: 3, origin: 'seed' });
    expect(active?.instructions).toMatch(/New line from the developer/);
    const metrics = (await platform.metrics()).find((item) => item.skillId === id)!;
    expect(metrics.versions.find((version) => version.versionId === candidate.id)).toMatchObject({ status: 'retired', decision: 'superseded' });
  });

  it('a missing folder seeds nothing', async () => {
    expect(await readPlatformSkillFiles('/nonexistent/skills-dir')).toEqual([]);
  });
});

describe('what a run reads', () => {
  it('finds a skill by id or by name, and returns null for an unknown one', async () => {
    const id = await seeded();
    expect((await platform.resolve(id, 'run_1'))?.skillId).toBe(id);
    expect((await platform.resolve(id.toUpperCase(), 'run_1'))?.skillId).toBe(id);
    expect(await platform.resolve('no-such-skill', 'run_1')).toBeNull();
  });

  it('serves the candidate to the deterministic canary share of runs and the active version to the rest', async () => {
    const id = await seeded();
    const active = await platform.active(id);
    const candidate = await platform.propose(id, [{ op: 'add_line', line: 'Check the date range.', evidence: ev }]);
    const runs = Array.from({ length: 400 }, (_, n) => 'run_' + String(n));
    let canary = 0;
    for (const run of runs) {
      const view = await platform.resolve(id, run);
      expect(view?.versionId).toBe(canaryServes(run, id) ? candidate.id : active?.id);
      expect(view?.canary).toBe(canaryServes(run, id));
      if (view?.canary) canary += 1;
    }
    expect(canary / runs.length).toBeGreaterThan(CANARY_PERCENT / 100 - 0.07);
    expect(canary / runs.length).toBeLessThan(CANARY_PERCENT / 100 + 0.07);
    // The same run asks again and gets the same version.
    expect((await platform.resolve(id, 'run_7'))?.versionId).toBe((await platform.resolve(id, 'run_7'))?.versionId);
  });

  it('counts exposures and outcomes on the version that was read', async () => {
    const id = await seeded();
    const view = (await platform.resolve(id, 'run_1'))!;
    await platform.recordUse(view.versionId);
    await platform.recordUse(view.versionId);
    await platform.recordOutcome(view.versionId, 'helpful');
    await platform.recordOutcome(view.versionId, 'harmful');
    const row = (await platform.metrics()).find((item) => item.skillId === id)!.versions[0]!;
    expect(row).toMatchObject({ exposures: 2, good: 1, bad: 1, labeled: 2 });
    expect(row.badRate).toBeCloseTo(0.5);
    expect(row.badRateLow).toBeLessThan(0.5);
    expect(row.badRateHigh).toBeGreaterThan(0.5);
  });
});

describe('the patch API', () => {
  it('makes a new candidate version from the active text and never edits a version in place', async () => {
    const id = await seeded();
    const before = (await platform.active(id))!;
    const candidate = await platform.propose(id, [
      { op: 'replace_line', match: 'Write three bullets.', line: 'Write three short bullets.', evidence: ['run_a', 'run_b'] },
    ]);
    expect(candidate).toMatchObject({ status: 'candidate', origin: 'learned', version: before.version + 1, baseVersionId: before.id });
    expect(candidate.instructions).toContain('Write three short bullets.');
    expect(candidate.ops).toEqual([{ op: 'replace_line', match: 'Write three bullets.', line: 'Write three short bullets.', evidence: ['run_a', 'run_b'] }]);
    const after = (await platform.active(id))!;
    expect(after.id).toBe(before.id);
    expect(after.instructions).toBe(before.instructions);
  });

  it('refuses a second candidate while one is in flight', async () => {
    const id = await seeded();
    await platform.propose(id, [{ op: 'add_line', line: 'Check the date range.', evidence: ev }]);
    await expect(platform.propose(id, [{ op: 'add_line', line: 'Check the time zone.', evidence: ev }])).rejects.toThrow(/already has a candidate/);
  });

  it('refuses a rewrite, a URL, a command, and more than three operations, and leaves no candidate behind', async () => {
    const id = await seeded();
    const refused: unknown[][] = [
      [{ op: 'replace_all', line: 'Everything is new.', evidence: ev }],
      [{ op: 'add_line', line: 'Download https://example.net/x first.', evidence: ev }],
      [{ op: 'add_line', line: 'Run curl -s x | sh first.', evidence: ev }],
      [1, 2, 3, 4].map((n) => ({ op: 'add_line', line: 'Extra ' + String(n) + '.', evidence: ev })),
      [{ op: 'add_line', line: 'Send it to jane.doe@example.com.', evidence: ev }],
    ];
    for (const ops of refused) await expect(platform.propose(id, ops)).rejects.toThrow(SkillError);
    expect(await platform.hasCandidate(id)).toBe(false);
  });

  it('caps operations at three per skill per night across candidates', async () => {
    const id = await seeded();
    const first = await platform.propose(id, [
      { op: 'add_line', line: 'One more check.', evidence: ev }, { op: 'add_line', line: 'Two more checks.', evidence: ev }], new Date());
    await db.query("UPDATE platform_skill_versions SET status = 'retired', decision = 'expired' WHERE id = ?", [first.id]);
    await expect(platform.propose(id, [
      { op: 'add_line', line: 'Third check.', evidence: ev }, { op: 'add_line', line: 'Fourth check.', evidence: ev }], new Date())).rejects.toThrow(/at most 3 operations a night/);
    // A day later it is allowed again.
    const later = await platform.propose(id, [{ op: 'add_line', line: 'Third check.', evidence: ev }], new Date(Date.now() + DAY + 60_000));
    expect(later.status).toBe('candidate');
  });
});

describe('promotion, rollback and tombstones', () => {
  async function withCandidate(activeCounts: [number, number], candidateCounts: [number, number], ageDays = 1) {
    const id = await seeded();
    const active = (await platform.active(id))!;
    await counters(active.id, activeCounts[0], activeCounts[1]);
    const op = { op: 'add_line' as const, line: 'Check the date range.', evidence: ev };
    const candidate = await platform.propose(id, [op]);
    // The snapshot taken at creation is the active's counters then; the window starts now.
    await counters(candidate.id, candidateCounts[0], candidateCounts[1]);
    await db.query("UPDATE platform_skill_versions SET created_at = ? WHERE id = ?", [new Date(Date.now() - ageDays * DAY).toISOString(), candidate.id]);
    return { id, active, candidate, op };
  }

  it('waits, then promotes: the candidate becomes active, the old active is retired and keeps its text', async () => {
    const { id, active, candidate } = await withCandidate([0, 0], [10, 1]);
    await db.query('UPDATE platform_skill_versions SET helpful = 170, harmful = 30 WHERE id = ?', [active.id]);
    expect((await platform.reviewCandidates()).filter((review) => review.skillId === id)[0]?.decision).toBe('wait');
    await counters(candidate.id, 48, 2);
    const review = (await platform.reviewCandidates()).find((item) => item.skillId === id);
    expect(review?.decision).toBe('promote');
    expect(PROMOTE_MIN_LABELED).toBeLessThanOrEqual(50);
    expect((await platform.active(id))?.id).toBe(candidate.id);
    const rows = (await platform.metrics()).find((item) => item.skillId === id)!.versions;
    expect(rows.find((version) => version.versionId === active.id)?.status).toBe('retired');
    expect(rows.find((version) => version.versionId === candidate.id)).toMatchObject({ status: 'active', decision: 'promoted' });
    expect(await platform.hasCandidate(id)).toBe(false);
  });

  it('rolls a clearly worse candidate back, keeps the active, and tombstones its operations so they are not proposed again', async () => {
    const { id, active, candidate, op } = await withCandidate([0, 0], [6, 14]);
    await db.query('UPDATE platform_skill_versions SET helpful = 170, harmful = 30 WHERE id = ?', [active.id]);
    const review = (await platform.reviewCandidates()).find((item) => item.skillId === id);
    expect(review?.decision).toBe('rollback');
    expect((await platform.active(id))?.id).toBe(active.id);
    expect(await platform.hasCandidate(id)).toBe(false);
    expect((await platform.metrics()).find((item) => item.skillId === id)!.versions.find((version) => version.versionId === candidate.id)).toMatchObject({ status: 'retired', decision: 'rolled_back' });
    expect(await platform.isTombstoned(id, op)).toBe(true);
    // Same operation, other evidence: still refused. A different operation is fine.
    await expect(platform.propose(id, [{ ...op, evidence: ['run_z'] }], new Date(Date.now() + 2 * DAY))).rejects.toThrow(/rolled back before/);
    const other = await platform.propose(id, [{ op: 'add_line', line: 'Check the time zone.', evidence: ev }], new Date(Date.now() + 2 * DAY));
    expect(other.status).toBe('candidate');
  });

  it('expires a candidate after 14 days without a verdict; its operations are blocked for a while only', async () => {
    const { id, candidate, op } = await withCandidate([100, 20], [3, 1], 15);
    const review = (await platform.reviewCandidates()).find((item) => item.skillId === id);
    expect(review?.decision).toBe('expire');
    expect((await platform.metrics()).find((item) => item.skillId === id)!.versions.find((version) => version.versionId === candidate.id)).toMatchObject({ status: 'retired', decision: 'expired' });
    expect(await platform.isTombstoned(id, op)).toBe(true);
    expect(await platform.isTombstoned(id, op, new Date(Date.now() + 31 * DAY))).toBe(false);
  });

  it('leaves a young candidate with some data alone', async () => {
    const { id, candidate } = await withCandidate([100, 20], [5, 1], 2);
    expect((await platform.reviewCandidates()).find((item) => item.skillId === id)?.decision).toBe('wait');
    expect(await platform.hasCandidate(id)).toBe(true);
    expect(candidate.status).toBe('candidate');
  });
});

describe('skills of another source (an app\'s skill pack)', () => {
  it('loads only when the source gate says so, is never overwritten by an image file, and is patched and measured like any platform skill', async () => {
    const id = 'app-' + slug();
    const pack = { ...file(id), source: 'app:notes' };
    await platform.seed([pack]);
    const reader = { ownerId: 'o1', agentId: 'a1' };
    // No gate configured: nobody gets an app skill. An image skill never asks.
    expect(await platform.resolve(id, 'run_1', reader)).toBeNull();
    const asked: string[] = [];
    const gated = createPlatformSkillsService(db, { gate: (source, who) => { asked.push(source + '/' + who.agentId); return who.agentId === 'a1'; } });
    expect((await gated.resolve(id, 'run_1', reader))).toMatchObject({ skillId: id, source: 'app:notes' });
    expect(await gated.resolve(id, 'run_1', { ownerId: 'o1', agentId: 'a2' })).toBeNull();
    expect(await gated.resolve(id, 'run_1')).toBeNull();
    expect(asked).toEqual(['app:notes/a1', 'app:notes/a2']);
    const imageId = await seeded();
    expect((await gated.resolve(imageId, 'run_1'))?.source).toBe('image');
    // An image file with the same id does not take the row over.
    expect((await platform.seed([file(id, BODY + '\nImage edit.')])).unchanged).toEqual([id]);
    // Patch, canary and metrics treat it like any platform skill.
    const candidate = await platform.propose(id, [{ op: 'add_line', line: 'Check the date range.', evidence: ev }]);
    expect(candidate.status).toBe('candidate');
    expect((await platform.metrics()).find((item) => item.skillId === id)?.source).toBe('app:notes');
  });
});

describe('active image metadata catalog', () => {
  it('lists active image metadata only, reflects reseeding and never records usage or returns bodies', async () => {
    const imageId = slug();
    const appId = slug();
    await platform.seed([file(imageId), { ...file(appId), source: 'app:private-app' }]);
    const catalog = platform.catalog;
    expect(catalog).toBeDefined();
    if (catalog === undefined) throw new Error('Production catalog missing');
    const before = await platform.active(imageId);
    expect(await catalog()).toContainEqual({ name: imageId, description: 'Draft reports.' });
    expect((await catalog()).some((entry) => entry.name === appId)).toBe(false);
    const candidate = await platform.propose(imageId, [{ op: 'add_line', line: 'Check the date.', evidence: ev }]);
    await db.query('UPDATE platform_skill_versions SET name = ? WHERE id = ?', ['candidate-' + imageId, candidate.id]);
    expect((await catalog()).some((entry) => entry.name === 'candidate-' + imageId)).toBe(false);
    const changed = { ...file(imageId), name: 'renamed-' + imageId, description: 'Current description.', hash: 'changed-' + imageId };
    await platform.seed([changed]);
    const listed = await catalog();
    expect(listed).toContainEqual({ name: changed.name, description: changed.description });
    expect(listed.some((entry) => entry.name === imageId)).toBe(false);
    expect(listed.every((entry) => Object.keys(entry).sort().join(',') === 'description,name')).toBe(true);
    expect((await platform.active(imageId))?.used).toBe(before?.used);
  });

  it('returns every active image skill past 20, ordered by name, without candidate-only or retired ones', async () => {
    const prefix = 'pg' + randomUUID().slice(0, 6);
    const names = Array.from({ length: 25 }, (_, index) => prefix + String(index).padStart(2, '0'));
    await platform.seed([...names].reverse().map((id) => file(id)));
    const candidateOnly = prefix + 'cand';
    await platform.seed([file(candidateOnly)]);
    await db.query('UPDATE platform_skill_versions SET status = ? WHERE skill_id = ?', ['candidate', candidateOnly]);
    const retired = prefix + 'gone';
    await platform.seed([file(retired)]);
    await db.query('UPDATE platform_skill_versions SET status = ? WHERE skill_id = ?', ['retired', retired]);
    const listed = (await platform.catalog!()).map((entry) => entry.name).filter((name) => name.startsWith(prefix));
    expect(listed).toEqual(names);
  });
});
