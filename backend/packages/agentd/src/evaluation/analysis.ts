/**
 * The weekly evaluation's analysis (BACKEND §11.1): pure functions over fake-able rows, no database and no model. The rows carry only
 * ids, tool names, enum kinds, model names and timestamps. The one text that is read is a user message, and only to decide whether it
 * corrects the agent; no text is ever written to a report, so a report never holds a step argument, an output or something the owner said.
 */
import type { SkillEvolutionReport } from './fleet.js';

/** One tool step of the window. `field` is the schema field a validation error named, when the step says so (see `fieldOf`). */
export interface ToolStepRow {
  stepId: string;
  runId: string;
  tool: string;
  failed: boolean;
  errorKind?: string;
  retryOf?: string;
  field?: string;
  model: string;
}

export interface RunRow {
  runId: string;
  model: string;
  conversationId?: string;
  startedAt: number;
  finishedAt?: number;
}

/** A message the owner or a platform person wrote; `text` is read by `isCorrection` and never copied into a report. */
export interface UserMessage {
  conversationId: string;
  at: number;
  text: string;
}

export interface ErrorGroup {
  tool: string;
  field: string;
  errorKind: string;
  model: string;
  count: number;
  /** Failed steps the same tool was retried after (a later step names this one in `retryOf`). */
  retried: number;
  retryRate: number;
  runsAffected: number;
  /** Share of the window's runs on this model that hit this group. */
  runShare: number;
  exampleStepIds: string[];
}

export type Bucket = 'fix_list' | 'transient' | 'policy' | 'unclassified' | 'agent_method';

export const BUCKET_ORDER: readonly Bucket[] = ['fix_list', 'transient', 'policy', 'unclassified', 'agent_method'];

export const BUCKET_LABEL: Record<Bucket, string> = {
  fix_list: 'fix list (ours): validation or harness error',
  transient: 'transient (external or timeout): do not learn',
  policy: 'policy: refused by permission or approval',
  unclassified: 'unclassified: other or unknown error kind',
  agent_method: 'agent method: the owner corrected the run (candidate for batch 8)',
};

export interface BucketSummary {
  bucket: Bucket;
  label: string;
  failedSteps: number;
  runs: number;
  exampleStepIds: string[];
  exampleRunIds: string[];
}

const EXAMPLES = 3;

/** The field a validation error named: the first `- <path>:` line of the teaching text (`toolArguments.ts argumentErrorText`), first segment only. */
const FIELD_LINE = /^- ([A-Za-z_][A-Za-z0-9_]{0,63})(?=[.[:])/m;

export function fieldOf(summary: string | undefined, errorKind: string | undefined): string | undefined {
  if (errorKind !== 'validation' || summary === undefined) return undefined;
  return FIELD_LINE.exec(summary)?.[1];
}

/** Failed tool steps grouped by (tool, field, errorKind, model); `runsByModel` is every run of the window per model (the share's denominator). */
export function groupErrors(steps: readonly ToolStepRow[], runsByModel: Readonly<Record<string, number>>): ErrorGroup[] {
  const retriedIds = new Set(steps.flatMap((step) => (step.retryOf === undefined ? [] : [step.retryOf])));
  const groups = new Map<string, { head: Pick<ErrorGroup, 'tool' | 'field' | 'errorKind' | 'model'>; steps: ToolStepRow[] }>();
  for (const step of steps) {
    if (!step.failed) continue;
    const head = { tool: step.tool, field: step.field ?? '-', errorKind: step.errorKind ?? 'unknown', model: step.model };
    const key = [head.tool, head.field, head.errorKind, head.model].join('\u0000');
    const group = groups.get(key) ?? { head, steps: [] };
    group.steps.push(step);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ head, steps: members }) => {
    const runsAffected = new Set(members.map((step) => step.runId)).size;
    const runTotal = runsByModel[head.model] ?? runsAffected;
    const retried = members.filter((step) => retriedIds.has(step.stepId)).length;
    return {
      ...head,
      count: members.length,
      retried,
      retryRate: ratio(retried, members.length),
      runsAffected,
      runShare: Math.min(1, ratio(runsAffected, runTotal)),
      exampleStepIds: members.slice(0, EXAMPLES).map((step) => step.stepId),
    };
  }).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool) || a.field.localeCompare(b.field));
}

/** Error kind to bucket. Ours to fix when the harness or a validation check said so; transient and policy are not learning material. */
export function bucketOfErrorKind(errorKind: string | undefined): Bucket {
  switch (errorKind) {
    case 'validation':
    case 'harness':
      return 'fix_list';
    case 'external':
    case 'timeout':
      return 'transient';
    case 'permission':
      return 'policy';
    default:
      return 'unclassified';
  }
}

// Correction heuristic (phase 1 is deterministic, no model call). A next message that starts with a plain "no" / "that's wrong" (English or
// Chinese), or that repeats the request of the run it follows, counts as the owner correcting the agent. Reviewed by hand before any learning.
const CORRECTION_START = /^(?:no\b|nope\b|nah\b|wrong\b|incorrect\b|not (?:that|this|what)\b|that'?s (?:wrong|not)\b|try again\b|redo\b|again\b|不对|不是|错了|不行|重来|再试一次)/i;
const CORRECTION_WINDOW_MS = 30 * 60_000;
const REPEAT_SIMILARITY = 0.6;

/** Jaccard overlap of character bigrams (letters and digits only): works for Chinese without word splitting. */
export function similarity(a: string, b: string): number {
  const bigrams = (text: string): Set<string> => {
    const plain = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const set = new Set<string>();
    for (let index = 0; index + 1 < plain.length; index++) set.add(plain.slice(index, index + 2));
    return set;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const gram of left) if (right.has(gram)) common++;
  return common / (left.size + right.size - common);
}

export function isCorrection(next: string, original: string | undefined): boolean {
  const text = next.trim();
  return CORRECTION_START.test(text) || (original !== undefined && similarity(text, original) >= REPEAT_SIMILARITY);
}

/** Runs whose conversation's next user message, within 30 minutes of the run's end, corrects it (`isCorrection` against the message that started the run). */
export function correctedRunIds(runs: readonly RunRow[], messages: readonly UserMessage[]): string[] {
  const byConversation = new Map<string, UserMessage[]>();
  for (const message of messages) {
    const list = byConversation.get(message.conversationId) ?? [];
    list.push(message);
    byConversation.set(message.conversationId, list);
  }
  return runs.filter((run) => {
    if (run.conversationId === undefined) return false;
    const list = byConversation.get(run.conversationId) ?? [];
    const end = run.finishedAt ?? run.startedAt;
    const original = [...list].reverse().find((message) => message.at <= run.startedAt);
    const next = list.find((message) => message.at > end);
    return next !== undefined && next.at - end <= CORRECTION_WINDOW_MS && isCorrection(next.text, original?.text);
  }).map((run) => run.runId);
}

/** Failed steps by bucket, plus the corrected runs. A run counts once per bucket it touches, so the totals can exceed the run count. */
export function attribute(steps: readonly ToolStepRow[], correctedRuns: readonly string[]): BucketSummary[] {
  const failed = new Map<Bucket, ToolStepRow[]>();
  for (const step of steps) {
    if (!step.failed) continue;
    const bucket = bucketOfErrorKind(step.errorKind);
    failed.set(bucket, [...(failed.get(bucket) ?? []), step]);
  }
  return BUCKET_ORDER.map((bucket) => {
    const members = failed.get(bucket) ?? [];
    const runIds = [...new Set(bucket === 'agent_method' ? correctedRuns : members.map((step) => step.runId))];
    return {
      bucket,
      label: BUCKET_LABEL[bucket],
      failedSteps: members.length,
      runs: runIds.length,
      exampleStepIds: members.slice(0, EXAMPLES).map((step) => step.stepId),
      exampleRunIds: runIds.slice(0, EXAMPLES),
    };
  });
}

export interface WeeklyReport {
  generatedAt: string;
  from: string;
  to: string;
  runs: number;
  runsByModel: Record<string, number>;
  toolSteps: number;
  failedSteps: number;
  groups: ErrorGroup[];
  buckets: BucketSummary[];
  correctedRunIds: string[];
  /** Fleet metrics and per platform skill version (BACKEND §5.15); absent when the job has no platform skills. */
  skillEvolution?: SkillEvolutionReport;
}

export function renderMarkdown(report: WeeklyReport): string {
  const lines: string[] = [
    `# Juno weekly evaluation: ${report.from.slice(0, 10)} to ${report.to.slice(0, 10)}`,
    '',
    `Generated ${report.generatedAt}. Runs in the window: ${report.runs}. Tool steps: ${report.toolSteps}. Failed tool steps: ${report.failedSteps}.`,
    'Only tool, field, error kind, model names and ids are here. No argument, output or message text.',
    '',
    '## Tool x model error table',
    '',
    'Retry rate = share of failed steps the same tool was retried after. Run share = runs on that model that hit the group, over all runs on that model.',
    'The `tool argument normalized` log line is only logged, not stored on any step, so it is not counted here.',
    '',
    '| tool | field | errorKind | model | count | retry rate | runs affected (share) | examples |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    ...report.groups.map((group) => `| ${group.tool} | ${group.field} | ${group.errorKind} | ${group.model} | ${group.count} | ${percent(group.retryRate)} | ${group.runsAffected} (${percent(group.runShare)}) | ${group.exampleStepIds.join(', ')} |`),
    ...(report.groups.length === 0 ? ['| none | | | | | | | |'] : []),
    '',
    '## Failure attribution',
    '',
    '| bucket | failed steps | runs | examples (step ids) | examples (run ids) |',
    '| --- | ---: | ---: | --- | --- |',
    ...report.buckets.map((bucket) => `| ${bucket.label} | ${bucket.failedSteps} | ${bucket.runs} | ${bucket.exampleStepIds.join(', ')} | ${bucket.exampleRunIds.join(', ')} |`),
    '',
    `Corrected runs (heuristic, review by hand): ${report.correctedRunIds.length}.`,
    '',
  ];
  return lines.join('\n');
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
