/**
 * The nightly outcome labels (BACKEND §5.15): the pure classifier from signals, then the job on a real (embedded) Postgres: which runs it
 * labels, that a label is written once, that the skill versions a run read are credited or blamed, and the fleet metrics. Owner ids and
 * run ids are unique per test file run because the database keeps rows between tests.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createPlatformSkillsService, createSkillsService, parsePlatformSkillFile, type PlatformSkillsService, type SkillsService } from '@agent-desktop/memory-graph/skills';
import { startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import type { ToolStepRow } from '../analysis.js';
import { fleetMetrics } from '../fleet.js';
import { creditOf, labelRun, labelRuns, type RunFacts } from '../outcomes.js';
import { writeWeeklyReport } from '../weekly.js';
import { HOUR, insertApproval, insertMessage, insertRun, insertStep, runDoc } from './evolution-fixtures.js';

const step = (over: Partial<ToolStepRow> & { stepId: string }): ToolStepRow => ({ runId: 'r', tool: 'shell.run', failed: false, model: '', ...over });
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({ status: 'completed', corrected: false, deniedApproval: false, blockedUnanswered: false, steps: [], ...over });

describe('labelRun (signals to label)', () => {
  it('labels a clean completed run ok', () => {
    expect(labelRun(facts())).toBe('ok');
    expect(labelRun(facts({ steps: [step({ stepId: 's1' })] }))).toBe('ok');
  });

  it('the owner correcting the run wins over everything else', () => {
    expect(labelRun(facts({ corrected: true, status: 'stopped', steps: [step({ stepId: 's1', failed: true, errorKind: 'other' })] }))).toBe('corrected');
  });

  it('stopping, a denied approval, or an unanswered block is abandonment', () => {
    expect(labelRun(facts({ status: 'stopped' }))).toBe('abandoned');
    expect(labelRun(facts({ deniedApproval: true }))).toBe('abandoned');
    expect(labelRun(facts({ status: 'blocked', blockedUnanswered: true }))).toBe('abandoned');
    expect(labelRun(facts({ status: 'blocked' }))).toBe('unknown');
  });

  it('an unclassified tool error is a method failure, even when a retry then worked', () => {
    const failed = step({ stepId: 's1', failed: true, errorKind: 'other' });
    expect(labelRun(facts({ steps: [failed] }))).toBe('failed_method');
    expect(labelRun(facts({ steps: [failed, step({ stepId: 's2', retryOf: 's1' })] }))).toBe('failed_method');
    expect(labelRun(facts({ steps: [step({ stepId: 's1', failed: true })] }))).toBe('failed_method');
  });

  it('outside errors, timeouts, permission, validation and harness errors are failed_other, and a recovered one is fine', () => {
    for (const errorKind of ['external', 'timeout', 'permission', 'validation', 'harness']) {
      expect(labelRun(facts({ steps: [step({ stepId: 's1', failed: true, errorKind })] }))).toBe('failed_other');
    }
    expect(labelRun(facts({ steps: [step({ stepId: 's1', failed: true, errorKind: 'external' }), step({ stepId: 's2', retryOf: 's1' })] }))).toBe('ok');
    expect(labelRun(facts({ status: 'failed' }))).toBe('failed_other');
  });

  it('a run that never finished is unknown', () => {
    expect(labelRun(facts({ status: 'running' }))).toBe('unknown');
  });

  it('credits ok, blames corrected / failed_method / abandoned, and leaves failed_other and unknown alone', () => {
    expect(creditOf('ok')).toBe('helpful');
    for (const bad of ['corrected', 'failed_method', 'abandoned'] as const) expect(creditOf(bad)).toBe('harmful');
    expect(creditOf('failed_other')).toBeUndefined();
    expect(creditOf('unknown')).toBeUndefined();
  });
});

describe('the nightly labeling job', () => {
  let database: TestDatabase;
  let db: DurableDb;
  let platform: PlatformSkillsService;
  let skills: SkillsService;

  beforeAll(async () => {
    database = await startTestDatabase();
    db = database.db;
    platform = createPlatformSkillsService(db);
    skills = createSkillsService(db);
  }, 240_000);

  afterAll(async () => {
    await database?.close();
  });

  const tag = randomUUID().slice(0, 8);
  const owner = 'owner-' + tag;
  const now = new Date();
  const at = (hoursAgo: number): Date => new Date(now.getTime() - hoursAgo * HOUR);

  it('labels settled runs once, credits the versions they read, defers young and blocked ones', async () => {
    const platformId = 'sk' + tag;
    await platform.seed([parsePlatformSkillFile(platformId, '---\nname: ' + platformId + '\ndescription: x\n---\nRead the sheet.\nWrite bullets.\n')!]);
    const platformVersion = (await platform.active(platformId))!.id;
    const own = await skills.create(owner, { name: 'Own ' + tag, description: 'mine', instructions: 'Do it my way.', deps: [] });
    const ownVersion = own.active!.id;
    const read = [{ skillId: platformId, versionId: platformVersion, platform: true }, { skillId: own.def.id, versionId: ownVersion }];
    const id = (name: string): string => `run-${name}-${tag}`;

    await insertRun(db, { id: id('ok'), ownerId: owner, startedAt: at(5), finishedAt: at(4), skills: read });
    // Corrected: the owner's next message, 5 minutes after the run, starts with "no".
    await insertRun(db, { id: id('corrected'), ownerId: owner, conversationId: 'conv-' + tag, startedAt: at(6), finishedAt: at(5.5), skills: read });
    await insertMessage(db, owner, 'conv-' + tag, 'msg-1-' + tag, 'make me a pdf of the sheet', at(6.1));
    await insertMessage(db, owner, 'conv-' + tag, 'msg-2-' + tag, "no, that's wrong, redo it", at(5.4));
    await insertRun(db, { id: id('method'), ownerId: owner, startedAt: at(5), finishedAt: at(4), skills: read });
    await insertStep(db, { id: id('s1'), runId: id('method'), ownerId: owner, tool: 'shell.run', status: 'failed', errorKind: 'other', at: at(4.9) });
    await insertStep(db, { id: id('s2'), runId: id('method'), ownerId: owner, tool: 'shell.run', status: 'completed', retryOf: id('s1'), at: at(4.8) });
    await insertRun(db, { id: id('other'), ownerId: owner, startedAt: at(5), finishedAt: at(4), skills: read });
    await insertStep(db, { id: id('s3'), runId: id('other'), ownerId: owner, tool: 'web_fetch', status: 'failed', errorKind: 'external', at: at(4.9) });
    await insertRun(db, { id: id('stopped'), ownerId: owner, status: 'stopped', startedAt: at(5), finishedAt: at(4) });
    await insertRun(db, { id: id('denied'), ownerId: owner, startedAt: at(5), finishedAt: at(4) });
    await insertApproval(db, owner, id('denied'), 'req-1-' + tag, 'denied', 'no');
    await insertRun(db, { id: id('revised'), ownerId: owner, startedAt: at(5), finishedAt: at(4) });
    await insertApproval(db, owner, id('revised'), 'req-2-' + tag, 'denied', 'revise');
    await insertRun(db, { id: id('young'), ownerId: owner, startedAt: at(1), finishedAt: new Date(now.getTime() - 10 * 60_000), skills: read });
    await insertRun(db, { id: id('blocked'), ownerId: owner, status: 'blocked', startedAt: at(3), finishedAt: at(2) });
    await insertRun(db, { id: id('stale'), ownerId: owner, status: 'running', startedAt: at(30) });
    await insertRun(db, { id: id('old'), ownerId: owner, startedAt: at(24 * 5), finishedAt: at(24 * 5 - 1) });

    const report = await labelRuns({ db, platform, skills, now: () => now });
    const mine = report.runs.filter((run) => run.ownerId === owner);
    const outcomeOf = (name: string): string | undefined => mine.find((run) => run.runId === id(name))?.outcome;
    expect(outcomeOf('ok')).toBe('ok');
    expect(outcomeOf('corrected')).toBe('corrected');
    expect(outcomeOf('method')).toBe('failed_method');
    expect(outcomeOf('other')).toBe('failed_other');
    expect(outcomeOf('stopped')).toBe('abandoned');
    expect(outcomeOf('denied')).toBe('abandoned');
    expect(outcomeOf('revised')).toBe('corrected');
    expect(outcomeOf('stale')).toBe('unknown');
    expect(outcomeOf('young')).toBeUndefined();
    expect(outcomeOf('old')).toBeUndefined();
    expect(outcomeOf('blocked')).toBeUndefined();
    expect(report.deferred).toBeGreaterThanOrEqual(1);
    expect((await runDoc(db, id('ok')))['outcome']).toBe('ok');
    expect((await runDoc(db, id('young')))['outcome']).toBeUndefined();

    // Credit and blame: 1 ok -> helpful; corrected + method -> harmful; other -> neither. Both the platform row and the owner's skill.
    const row = (await platform.metrics()).find((item) => item.skillId === platformId)!.versions[0]!;
    expect(row).toMatchObject({ good: 1, bad: 2, labeled: 3 });
    const mineSkill = (await skills.get(owner, own.def.id))!.active!;
    expect(mineSkill).toMatchObject({ helpful: 1, harmful: 2 });

    // A second night labels none of them again and moves no counter.
    const again = await labelRuns({ db, platform, skills, now: () => now });
    expect(again.runs.filter((run) => run.ownerId === owner)).toEqual([]);
    expect((await platform.metrics()).find((item) => item.skillId === platformId)!.versions[0]).toMatchObject({ good: 1, bad: 2 });

    // The blocked run is abandoned once it has waited a day for an answer.
    const later = await labelRuns({ db, platform, skills, now: () => new Date(now.getTime() + 25 * HOUR) });
    expect(later.runs.find((run) => run.runId === id('blocked'))?.outcome).toBe('abandoned');
  });

  it('computes the fleet metrics from the labels, without any text', async () => {
    const who = 'fleet-' + randomUUID().slice(0, 8);
    const t = new Date();
    await insertRun(db, { id: 'f-ok-' + who, ownerId: who, startedAt: t, finishedAt: t, outcome: 'ok', usage: { costUsd: 0.02 } });
    await insertRun(db, { id: 'f-bad-' + who, ownerId: who, startedAt: t, finishedAt: t, outcome: 'corrected', usage: { costUsd: 0.04 } });
    await insertRun(db, { id: 'f-unk-' + who, ownerId: who, startedAt: t, finishedAt: t, outcome: 'unknown', usage: { costUsd: 9, costKnown: false } });
    await insertStep(db, { id: 'f-s1-' + who, runId: 'f-ok-' + who, ownerId: who, tool: 'shell.run', status: 'failed', errorKind: 'other', at: t });
    await insertStep(db, { id: 'f-s2-' + who, runId: 'f-ok-' + who, ownerId: who, tool: 'shell.run', status: 'completed', retryOf: 'f-s1-' + who, at: t });
    const metrics = await fleetMetrics(db);
    expect(metrics.byOutcome.corrected).toBeGreaterThanOrEqual(1);
    expect(metrics.labeled).toBeGreaterThanOrEqual(3);
    expect(metrics.correctionRate).toBeGreaterThan(0);
    expect(metrics.retryRate).toBeGreaterThan(0);
    expect(metrics.costPerRunUsd).not.toBeNull();
    expect(JSON.stringify(metrics)).not.toMatch(/owner|fleet-/);
  });

  it('puts the fleet metrics and the per-version skill numbers in the weekly report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evolve-weekly-'));
    try {
      const { markdownPath, jsonPath, report } = await writeWeeklyReport({ db, platformSkills: platform, dir, log: { info: () => undefined, error: () => undefined } });
      expect(report.skillEvolution?.skills.length).toBeGreaterThan(0);
      const markdown = await readFile(markdownPath, 'utf8');
      expect(markdown).toContain('## Platform skills and fleet metrics');
      expect(markdown).toMatch(/bad rate \(95% Wilson\)/);
      expect(JSON.parse(await readFile(jsonPath, 'utf8')).skillEvolution.fleet.windowDays).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
