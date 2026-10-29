/**
 * The skill patch API (BACKEND §5.15): a skill is only ever changed by line operations, never replaced as a whole. Three operations,
 * each anchored on the exact text of a line that occurs exactly once:
 *   add_line     { line, after? }   insert `line` after the line `after` (no `after`: at the end)
 *   replace_line { match, line }    swap the line `match` for `line`
 *   remove_line  { match }          delete the line `match`
 * Every operation cites the run ids that are its evidence. Rules, all plain code (no model): at most MAX_OPS_PER_SKILL_PER_NIGHT operations;
 * a written line is one line of at most MAX_OP_LINE_CHARS; it holds no URL and no shell command; it passes the personal-data and
 * authority rules of `validateSkillText`, and so must the whole result; at most MAX_CHANGED_LINE_SHARE of the lines may be replaced or removed.
 * The heuristics are not a proof of safety: the real limit is that no permission decision reads skill text, and the canary rolls a bad edit back.
 */
import { createHash } from 'node:crypto';
import { MAX_CHANGED_LINE_SHARE, MAX_EVIDENCE_PER_OP, MAX_OPS_PER_SKILL_PER_NIGHT, MAX_OP_LINE_CHARS } from './evolve.js';
import { SkillError } from './types.js';
import { findSkillProblem, validateSkillText } from './validate.js';

export type LineOp =
  | { op: 'add_line'; line: string; after?: string; evidence: string[] }
  | { op: 'replace_line'; match: string; line: string; evidence: string[] }
  | { op: 'remove_line'; match: string; evidence: string[] };

export interface RejectedOp {
  op: unknown;
  reason: string;
}

export interface LinePlan {
  /** The operations that applied, in order. */
  applied: LineOp[];
  rejected: RejectedOp[];
  /** The skill text after the applied operations. */
  text: string;
}

const RUN_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_ANCHOR_CHARS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const URL_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|org|net|io|dev|ai|app|co|cn|me|xyz|info|ly|sh|ru|tk)(?:\/|\b)/i,
];

const SHELL_BINARIES = 'sudo|curl|wget|rm|chmod|chown|mkfs|dd|nc|ncat|ssh|scp|rsync|eval|bash|zsh|powershell|python3?|perl|ruby|npm|npx|pnpm|pip3?|apt|apt-get|brew|docker|pkill|crontab|systemctl';
const SHELL_PATTERNS: readonly RegExp[] = [
  /```/,
  /^\s*\$\s+\S/,
  /\$\(/,
  /`[^`]*[|;&<>$][^`]*`/,
  /&&|\|\||>>|\b2>&1|\|\s*(?:sh|bash|zsh)\b|>\s*\/\w/,
  new RegExp(`(?:^|[\\s\`;|&(])(?:${SHELL_BINARIES})\\s+(?:[-./~$'"]|[^\\s]*[./][^\\s]*)`, 'i'),
];

/** What makes a line unfit to be written by a learned edit (a URL or a shell command), or undefined when it is fine. */
export function findInjectedContent(line: string): 'a URL' | 'a shell command' | undefined {
  if (URL_PATTERNS.some((pattern) => pattern.test(line))) return 'a URL';
  if (SHELL_PATTERNS.some((pattern) => pattern.test(line))) return 'a shell command';
  return undefined;
}

/** The same operation always hashes the same, whatever its evidence: this is what a tombstone remembers. */
export function opHash(skillId: string, op: LineOp): string {
  const key = JSON.stringify([skillId, op.op, 'match' in op ? op.match : '', 'after' in op ? op.after ?? '' : '', 'line' in op ? op.line : '']);
  return createHash('sha256').update(key).digest('hex');
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** One raw operation checked for shape and for the rules that do not need the skill text; a string is the reason it is refused. */
export function parseLineOp(raw: unknown): LineOp | string {
  if (!isRecord(raw)) return 'an operation is an object';
  const kind = raw['op'];
  if (kind !== 'add_line' && kind !== 'replace_line' && kind !== 'remove_line') return 'unknown operation (only add_line, replace_line and remove_line exist)';
  const allowed = new Set(['op', 'line', 'after', 'match', 'evidence']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return 'unknown field in the operation';
  const evidence = raw['evidence'];
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > MAX_EVIDENCE_PER_OP || !evidence.every((id) => typeof id === 'string' && RUN_ID.test(id))) {
    return 'evidence must be 1 to ' + String(MAX_EVIDENCE_PER_OP) + ' run ids';
  }
  const ids = [...new Set(evidence as string[])];
  const anchor = (key: 'match' | 'after'): string | undefined => {
    const value = text(raw, key);
    return value !== undefined && value.trim() !== '' && value.length <= MAX_ANCHOR_CHARS && !/[\r\n]/.test(value) ? value.trimEnd() : undefined;
  };
  if (kind === 'remove_line') {
    if (raw['line'] !== undefined || raw['after'] !== undefined) return 'remove_line takes only match';
    const match = anchor('match');
    return match === undefined ? 'match must be the exact text of one line' : { op: kind, match, evidence: ids };
  }
  const line = text(raw, 'line');
  if (line === undefined || line.trim() === '' || /[\r\n]/.test(line) || line.length > MAX_OP_LINE_CHARS) {
    return 'line must be one line of 1 to ' + String(MAX_OP_LINE_CHARS) + ' characters';
  }
  const flagged = findSkillProblem(line);
  if (flagged !== undefined) return flagged.kind === 'authority' ? 'the line tries to grant authority (' + flagged.label + ')' : 'the line contains ' + flagged.label;
  const problem = findInjectedContent(line);
  if (problem !== undefined) return 'the line contains ' + problem;
  if (kind === 'add_line') {
    if (raw['match'] !== undefined) return 'add_line takes line and an optional after';
    if (raw['after'] === undefined || raw['after'] === null) return { op: kind, line: line.trimEnd(), evidence: ids };
    const after = anchor('after');
    return after === undefined ? 'after must be the exact text of one line' : { op: kind, line: line.trimEnd(), after, evidence: ids };
  }
  if (raw['after'] !== undefined) return 'replace_line takes match and line';
  const match = anchor('match');
  return match === undefined ? 'match must be the exact text of one line' : { op: kind, match, line: line.trimEnd(), evidence: ids };
}

/** The single index of the line equal to `anchor` (trailing blanks aside), or the reason there is none. */
function locate(lines: readonly string[], anchor: string): number | string {
  const hits: number[] = [];
  lines.forEach((candidate, index) => {
    if (candidate.trimEnd() === anchor) hits.push(index);
  });
  if (hits.length === 0) return 'no line matches exactly';
  if (hits.length > 1) return 'the anchor matches ' + String(hits.length) + ' lines; it must match one';
  return hits[0] ?? 0;
}

/**
 * Apply operations one by one to the skill text; an operation that breaks a rule is rejected with its reason and the rest still apply.
 * The name and description are never touched by an operation, so only the text is validated (`validateSkillText` with a stand-in name).
 */
export function planLineOps(instructions: string, rawOps: readonly unknown[]): LinePlan {
  let lines = instructions.split('\n');
  const total = lines.filter((line) => line.trim() !== '').length;
  const allowedChanges = Math.max(1, Math.floor(total * MAX_CHANGED_LINE_SHARE));
  let changed = 0;
  const applied: LineOp[] = [];
  const rejected: RejectedOp[] = [];
  const seen = new Set<string>();
  for (const [position, raw] of rawOps.entries()) {
    const refuse = (reason: string): void => {
      rejected.push({ op: raw, reason });
    };
    if (position >= MAX_OPS_PER_SKILL_PER_NIGHT) {
      refuse('more than ' + String(MAX_OPS_PER_SKILL_PER_NIGHT) + ' operations for one skill in one night');
      continue;
    }
    const op = parseLineOp(raw);
    if (typeof op === 'string') {
      refuse(op);
      continue;
    }
    const key = JSON.stringify([op.op, 'match' in op ? op.match : '', 'after' in op ? op.after ?? '' : '', 'line' in op ? op.line : '']);
    if (seen.has(key)) {
      refuse('the same operation twice');
      continue;
    }
    const next = applyOne(lines, op);
    if (typeof next === 'string') {
      refuse(next);
      continue;
    }
    const destructive = op.op !== 'add_line';
    if (destructive && changed + 1 > allowedChanges) {
      refuse('it would change more than ' + String(allowedChanges) + ' of ' + String(total) + ' lines; a skill is not rewritten as a whole');
      continue;
    }
    try {
      validateSkillText({ name: 'skill', description: '', instructions: next.join('\n').trim() });
    } catch (error) {
      refuse(error instanceof SkillError ? error.message : 'the result is not a valid skill');
      continue;
    }
    lines = next;
    seen.add(key);
    if (destructive) changed += 1;
    applied.push(op);
  }
  return { applied, rejected, text: lines.join('\n').trim() };
}

function applyOne(lines: readonly string[], op: LineOp): string[] | string {
  if (op.op === 'add_line') {
    if (lines.some((line) => line.trimEnd() === op.line)) return 'that line is already in the skill';
    if (op.after === undefined) return [...trimEndBlank(lines), op.line];
    const at = locate(lines, op.after);
    if (typeof at === 'string') return 'after: ' + at;
    return [...lines.slice(0, at + 1), op.line, ...lines.slice(at + 1)];
  }
  const at = locate(lines, op.match);
  if (typeof at === 'string') return 'match: ' + at;
  if (op.op === 'remove_line') return [...lines.slice(0, at), ...lines.slice(at + 1)];
  if (lines[at]?.trimEnd() === op.line) return 'the replacement is the same line';
  return [...lines.slice(0, at), op.line, ...lines.slice(at + 1)];
}

function trimEndBlank(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(0, end);
}

/** All-or-nothing: the new text, or a SKILL_INVALID error naming the first operation that breaks a rule (and more than the nightly cap is refused outright). */
export function applyLineOps(instructions: string, rawOps: readonly unknown[]): LinePlan {
  if (rawOps.length === 0) throw new SkillError('SKILL_INVALID', 'A patch needs at least one operation.');
  if (rawOps.length > MAX_OPS_PER_SKILL_PER_NIGHT) {
    throw new SkillError('SKILL_INVALID', 'A skill takes at most ' + String(MAX_OPS_PER_SKILL_PER_NIGHT) + ' operations a night.');
  }
  const plan = planLineOps(instructions, rawOps);
  const first = plan.rejected[0];
  if (first !== undefined) throw new SkillError('SKILL_INVALID', 'Operation refused: ' + first.reason + '.');
  return plan;
}
