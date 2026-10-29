/**
 * The platform reflector against a real model (BACKEND §5.15). Skipped unless E2E_REAL_MODEL is set; then it calls the OpenAI-compatible
 * endpoint E2E_MODEL_BASE_URL (default the local OCX proxy) with a seeded failing platform skill and checks behaviour, never wording:
 * what comes back is at most three line operations, every one already passed the patch API's rules (exact anchors, no URL, no command,
 * evidence from the shown runs), and a candidate exists only when operations survived. Prints what the model proposed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createPlatformSkillsService, parsePlatformSkillFile, type PlatformSkillsService } from '@agent-desktop/memory-graph/skills';
import { startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import { createChatComplete, type PlatformModelEnv } from '../platform-model.js';
import { reflectNight } from '../reflector.js';
import type { LabeledRun } from '../outcomes.js';
import { HOUR, insertRun } from './evolution-fixtures.js';

const modelId = process.env['E2E_REAL_MODEL'];
const model: PlatformModelEnv | undefined = modelId === undefined || modelId === '' ? undefined : {
  modelId, baseUrl: (process.env['E2E_MODEL_BASE_URL'] ?? 'http://127.0.0.1:10100/v1').replace(/\/+$/, ''), apiKey: process.env['E2E_MODEL_API_KEY'] ?? 'none',
};

const SKILL = [
  '# PDF',
  'Tool: `/opt/juno/skills/pdf/pdf_tool.py` (Chromium prints, pypdf edits).',
  '- New document: write `/workspace/spec.json` then `pdf_tool.py create /workspace/out.pdf /workspace/spec.json`.',
  '- Existing PDFs: `merge OUT IN...`, `split IN OUTDIR`, `text IN` (read content), `info IN`.',
  '- Check a new PDF with `text`, then deliver it with `artifact_publish {path, title}`.',
].join('\n');

describe.skipIf(model === undefined)('platform reflector on a real model', () => {
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

  it('proposes at most three valid line operations for a skill whose runs keep failing the same way', async () => {
    const skillId = 'pdf-' + randomUUID().slice(0, 6);
    await platform.seed([parsePlatformSkillFile(skillId, `---\nname: ${skillId}\ndescription: Create PDFs or edit existing ones.\n---\n${SKILL}\n`)!]);
    const versionId = (await platform.active(skillId))!.id;
    const now = new Date();
    const labeled: LabeledRun[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = `real-${skillId}-${i}`;
      await insertRun(db, {
        id, ownerId: 'owner-' + i, startedAt: new Date(now.getTime() - 5 * HOUR), finishedAt: new Date(now.getTime() - 4 * HOUR),
        skills: [{ skillId, versionId, platform: true }],
        steps: [
          { id: 'a', kind: 'shell', tool: 'skill_read', status: 'completed', title: 'Read the pdf skill' },
          { id: 'b', kind: 'shell', tool: 'shell.run', status: 'failed', errorKind: 'other', title: 'Ran pdf_tool.py split with a page range: unknown option' },
          { id: 'c', kind: 'shell', tool: 'shell.run', status: 'failed', errorKind: 'other', retryOf: 'b', title: 'Retried split with the pages as a third argument: failed again' },
          { id: 'd', kind: 'shell', tool: 'shell.run', status: 'completed', retryOf: 'c', title: 'Found the pages command by running pdf_tool.py with no arguments' },
        ],
      });
      labeled.push({ runId: id, ownerId: 'owner-' + i, outcome: i % 2 === 0 ? 'failed_method' : 'corrected', skills: [{ skillId, versionId, platform: true }] });
    }
    for (let i = 0; i < 2; i += 1) {
      await insertRun(db, {
        id: `real-good-${skillId}-${i}`, ownerId: 'owner-g', startedAt: new Date(now.getTime() - 6 * HOUR), finishedAt: new Date(now.getTime() - 5 * HOUR), outcome: 'ok',
        skills: [{ skillId, versionId, platform: true }],
        steps: [{ id: 'g', kind: 'shell', tool: 'shell.run', status: 'completed', title: 'Merged two PDFs and checked the page count' }],
      });
    }
    const complete = createChatComplete(model!);
    const [result] = await reflectNight({ db, platform, complete, log: { info: () => undefined, error: (fields, message) => console.error(message, fields) }, now: () => now }, labeled);
    const candidate = (await platform.metrics()).find((item) => item.skillId === skillId)!.versions.find((version) => version.status === 'candidate');
    const active = await platform.active(skillId);
    console.log('[reflector-real]', JSON.stringify({ model: model!.modelId, proposed: result?.proposed, rejected: result?.rejected, skipped: result?.skipped }));
    if (candidate !== undefined) {
      const stored = (await db.query<{ ops: unknown; instructions: string }>('SELECT ops, instructions FROM platform_skill_versions WHERE id = ?', [candidate.versionId]))[0]!;
      console.log('[reflector-real] ops', JSON.stringify(stored.ops));
      console.log('[reflector-real] text after\n' + stored.instructions);
    }
    expect(result).toBeDefined();
    expect(result?.skipped).toBeUndefined();
    expect(result?.proposed ?? 0).toBeLessThanOrEqual(3);
    expect(candidate === undefined ? 0 : candidate.opCount).toBe(result?.proposed ?? 0);
    expect(active?.instructions).toBe(SKILL);
  }, 240_000);
});
