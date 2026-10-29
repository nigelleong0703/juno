/**
 * The nightly outcome labels (BACKEND §5.15): every finished run gets one of `ok | corrected | failed_method | failed_other | abandoned |
 * unknown`, from signals the platform already has and plain code only (the model never grades itself). The classifier reuses the weekly
 * report's: the owner-correction heuristic (`correctedRunIds`) and the error-kind buckets (`bucketOfErrorKind`). Each skill version the run
 * read is then credited (`helpful` on ok) or blamed (`harmful` on corrected, failed_method, abandoned); failed_other and unknown are neither.
 * Exposure is reading, not proof of following: a counter is a correlation, and the canary plus the rollback are the safety net.
 */
import type { DurableDb } from '@agent-desktop/durable';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import {
  BLOCKED_ABANDON_HOURS, LABEL_LOOKBACK_DAYS, LABEL_MAX_RUNS_PER_NIGHT, LABEL_SETTLE_MINUTES,
} from '@agent-desktop/memory-graph/skills';
import { bucketOfErrorKind, correctedRunIds, type RunRow, type ToolStepRow, type UserMessage } from './analysis.js';

export type Outcome = 'ok' | 'corrected' | 'failed_method' | 'failed_other' | 'abandoned' | 'unknown';

/** The outcomes that count against the skill versions the run read. */
export const BAD_OUTCOMES: ReadonlySet<Outcome> = new Set(['corrected', 'failed_method', 'abandoned']);

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL = ['completed', 'failed', 'stopped', 'blocked'];
/** A run that is still not terminal after this long is stuck: it is labelled `unknown` and never counted either way. */
const STALE_RUN_HOURS = 24;
const CHUNK = 200;

export interface RunFacts {
  status: string;
  /** The owner's next message corrected the run (the weekly heuristic), or an approval was answered with a revision. */
  corrected: boolean;
  /** An approval of the run was denied outright. */
  deniedApproval: boolean;
  /** Blocked, and nobody wrote in that conversation afterwards. */
  blockedUnanswered: boolean;
  steps: readonly ToolStepRow[];
}

/** One run's label. Order: the owner's reaction first, then abandonment, then what the tools did, else ok. */
export function labelRun(facts: RunFacts): Outcome {
  if (!TERMINAL.includes(facts.status)) return 'unknown';
  if (facts.corrected) return 'corrected';
  if (facts.status === 'stopped' || facts.deniedApproval || facts.blockedUnanswered) return 'abandoned';
  if (facts.status === 'blocked') return 'unknown';
  const recovered = new Set(facts.steps.filter((step) => !step.failed && step.retryOf !== undefined).map((step) => step.retryOf));
  const failed = facts.steps.filter((step) => step.failed);
  // An error of a kind nobody classified (not validation, harness, external, timeout, permission) is the agent's own way of doing it, even if a retry then worked.
  if (failed.some((step) => bucketOfErrorKind(step.errorKind) === 'unclassified')) return 'failed_method';
  if (facts.status === 'failed' || failed.some((step) => !recovered.has(step.stepId))) return 'failed_other';
  return 'ok';
}

export function creditOf(outcome: Outcome): 'helpful' | 'harmful' | undefined {
  if (outcome === 'ok') return 'helpful';
  return BAD_OUTCOMES.has(outcome) ? 'harmful' : undefined;
}

export interface LabeledRun {
  runId: string;
  ownerId: string;
  outcome: Outcome;
  skills: Array<{ skillId: string; versionId: string; platform: boolean }>;
}

export interface LabelReport {
  labeled: number;
  deferred: number;
  byOutcome: Record<Outcome, number>;
  credited: number;
  runs: LabeledRun[];
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const time = (value: unknown): number => new Date(value as string).getTime();
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += CHUNK) out.push(items.slice(at, at + CHUNK));
  return out;
}

function skillsOf(raw: unknown): LabeledRun['skills'] {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const skillId = Reflect.get(entry, 'skillId');
    const versionId = Reflect.get(entry, 'versionId');
    return typeof skillId === 'string' && typeof versionId === 'string' ? [{ skillId, versionId, platform: Reflect.get(entry, 'platform') === true }] : [];
  });
}

export interface LabelDeps {
  db: DurableDb;
  /** Credits the owner skill versions a run read (their counters are per owner). */
  skills?: SkillsService;
  platform?: PlatformSkillsService;
  now?: () => Date;
}

/**
 * Label the runs that settled and have no label yet, and credit or blame the skill versions each one read. A run is claimed by one
 * conditional UPDATE before its counters move, so a repeated or concurrent job never counts a run twice (a crash between the claim and the
 * counters loses a count, never doubles one).
 */
export async function labelRuns(deps: LabelDeps): Promise<LabelReport> {
  const now = (deps.now ?? (() => new Date()))();
  const settled = new Date(now.getTime() - LABEL_SETTLE_MINUTES * 60_000).toISOString();
  const stale = new Date(now.getTime() - STALE_RUN_HOURS * 60 * 60_000).toISOString();
  const lookback = new Date(now.getTime() - LABEL_LOOKBACK_DAYS * DAY_MS).toISOString();
  const candidates = await deps.db.query<Row>(
    `SELECT r.id AS run_id, r.owner_id, r.conversation_id, r.at, r.doc->>'status' AS status, r.doc->>'finishedAt' AS finished_at, r.doc->'skills' AS skills
     FROM runs r
     WHERE r.doc->>'outcome' IS NULL AND r.at >= ?::timestamptz
       AND ((r.doc->>'status' IN ('completed', 'failed', 'stopped', 'blocked') AND (r.doc->>'finishedAt')::timestamptz <= ?::timestamptz)
         OR (r.doc->>'status' NOT IN ('completed', 'failed', 'stopped', 'blocked') AND r.at <= ?::timestamptz))
     ORDER BY r.at LIMIT ?`,
    [lookback, settled, stale, LABEL_MAX_RUNS_PER_NIGHT],
  );
  const report: LabelReport = {
    labeled: 0, deferred: 0, credited: 0, runs: [],
    byOutcome: { ok: 0, corrected: 0, failed_method: 0, failed_other: 0, abandoned: 0, unknown: 0 },
  };
  if (candidates.length === 0) return report;

  const ids = candidates.map((row) => String(row['run_id']));
  const steps = new Map<string, ToolStepRow[]>();
  const denied = new Set<string>();
  const messages: UserMessage[] = [];
  const conversations = [...new Set(candidates.flatMap((row) => (text(row['conversation_id']) === undefined ? [] : [String(row['conversation_id'])])))];
  const firstAt = candidates.reduce((min, row) => Math.min(min, time(row['at'])), Number.POSITIVE_INFINITY);
  for (const part of chunks(ids)) {
    const stepRows = await deps.db.query<Row>(
      `SELECT s.id AS step_id, s.run_id, s.doc->>'tool' AS tool, s.status, s.doc->>'errorKind' AS error_kind, s.doc->>'retryOf' AS retry_of
       FROM steps s WHERE s.run_id IN (${marks(part.length)}) AND s.doc->>'tool' IS NOT NULL`,
      part,
    );
    for (const row of stepRows) {
      const errorKind = text(row['error_kind']);
      const retryOf = text(row['retry_of']);
      const list = steps.get(String(row['run_id'])) ?? [];
      list.push({
        stepId: String(row['step_id']), runId: String(row['run_id']), tool: String(row['tool']), failed: row['status'] === 'failed', model: '',
        ...(errorKind === undefined ? {} : { errorKind }), ...(retryOf === undefined ? {} : { retryOf }),
      });
      steps.set(String(row['run_id']), list);
    }
    const requestRows = await deps.db.query<Row>(
      `SELECT q.run_id FROM requests q WHERE q.run_id IN (${marks(part.length)}) AND q.kind = 'approval' AND q.status = 'denied'
         AND COALESCE(q.doc->'decision'->>'reason', '') <> 'revise'`,
      part,
    );
    for (const row of requestRows) denied.add(String(row['run_id']));
  }
  // A revised approval (the owner changed what the agent drafted before allowing it) is an owner correction too.
  const revised = new Set<string>();
  for (const part of chunks(ids)) {
    const rows = await deps.db.query<Row>(
      `SELECT q.run_id FROM requests q WHERE q.run_id IN (${marks(part.length)}) AND q.kind = 'approval' AND q.status = 'denied'
         AND q.doc->'decision'->>'reason' = 'revise'`,
      part,
    );
    for (const row of rows) revised.add(String(row['run_id']));
  }
  for (const part of chunks(conversations)) {
    const rows = await deps.db.query<Row>(
      `SELECT i.conversation_id, i.at, i.doc->>'text' AS text FROM items i
       WHERE i.conversation_id IN (${marks(part.length)}) AND i.doc->>'type' = 'user_message' AND i.at >= ?::timestamptz ORDER BY i.conversation_id, i.at`,
      [...part, new Date(firstAt - DAY_MS).toISOString()],
    );
    for (const row of rows) messages.push({ conversationId: String(row['conversation_id']), at: time(row['at']), text: text(row['text']) ?? '' });
  }

  const runRows: RunRow[] = candidates.map((row) => ({
    runId: String(row['run_id']), model: '', startedAt: time(row['at']),
    ...(text(row['conversation_id']) === undefined ? {} : { conversationId: String(row['conversation_id']) }),
    ...(text(row['finished_at']) === undefined ? {} : { finishedAt: time(row['finished_at']) }),
  }));
  const corrected = new Set(correctedRunIds(runRows, messages));
  const lastMessageAt = new Map<string, number>();
  for (const message of messages) lastMessageAt.set(message.conversationId, Math.max(lastMessageAt.get(message.conversationId) ?? 0, message.at));

  for (const row of candidates) {
    const runId = String(row['run_id']);
    const status = String(row['status']);
    const run = runRows.find((item) => item.runId === runId);
    const finishedAt = run?.finishedAt ?? run?.startedAt ?? 0;
    let blockedUnanswered = false;
    if (status === 'blocked') {
      const answered = run?.conversationId !== undefined && (lastMessageAt.get(run.conversationId) ?? 0) > finishedAt;
      // A blocked run waits a day for the owner to answer before it counts as abandoned.
      if (!answered && now.getTime() - finishedAt < BLOCKED_ABANDON_HOURS * 60 * 60_000) {
        report.deferred += 1;
        continue;
      }
      blockedUnanswered = !answered;
    }
    const outcome = labelRun({
      status, corrected: corrected.has(runId) || revised.has(runId), deniedApproval: denied.has(runId), blockedUnanswered, steps: steps.get(runId) ?? [],
    });
    const claimed = await deps.db.query<Row>(
      `UPDATE runs SET doc = doc || jsonb_build_object('outcome', ?::text) WHERE id = ? AND doc->>'outcome' IS NULL RETURNING id`,
      [outcome, runId],
    );
    if (claimed.length === 0) continue;
    const ownerId = String(row['owner_id']);
    const exposed = skillsOf(row['skills']);
    report.labeled += 1;
    report.byOutcome[outcome] += 1;
    report.runs.push({ runId, ownerId, outcome, skills: exposed });
    const credit = creditOf(outcome);
    if (credit === undefined) continue;
    for (const skill of exposed) {
      if (skill.platform) await deps.platform?.recordOutcome(skill.versionId, credit);
      else await deps.skills?.recordOutcome(ownerId, skill.versionId, credit);
      report.credited += 1;
    }
  }
  return report;
}
