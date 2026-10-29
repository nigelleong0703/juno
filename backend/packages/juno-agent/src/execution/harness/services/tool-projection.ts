/**
 * Bounded, redacted tool projections (PH7). A tool result is projected before it reaches the
 * transcript, the replay cache or the model context, so a credential a tool echoes or an unbounded
 * payload never lands in the journal.
 *
 * Bounding is aggregate, never per block, and it never touches a tool that pages its own output: a
 * `files.read` window carries `nextStartLine` and a long body carries its own truncation
 * marker, so clipping those would make the model silently skip content the cursor claims it saw.
 * When a result that does not page is still too large, the text is bounded and the cut is stated
 * explicitly (in the result and in `details.policyTruncation`) with a recoverable path instead of a
 * silent marker. Image blocks are kept intact: the model needs them and their size is already
 * bounded by the capture.
 */
import type { Doc, ToolResult } from '../../../contracts/index.js';
import { stepErrorKindSchema, type StepErrorKind, type StepStatus } from '@agent-desktop/public-contracts';
import { interruptedReason } from './replay.js';
import { redactText } from './redaction.js';
export { redactText } from './redaction.js';

/** One authorized outcome: executed, refused before any effect, interrupted mid-action, or stopped. */
export type ToolOutcome =
  | { kind: 'ran'; result: ToolResult }
  | { kind: 'refused'; result: ToolResult }
  | { kind: 'interrupted'; result: ToolResult }
  | { kind: 'cancelled' };

/**
 * Total characters of text kept from one result: about 12k tokens, what Codex keeps per tool output
 * (10k tokens plus its serialization allowance). Tools that page their own output declare a
 * continuation and are never clipped here (`files.read` pages a 64KiB window and says where it
 * continues); a 20k-character result and stays under the budget. This only bounds a
 * result no tool bounded, once, before it enters the history: the history is never rewritten later.
 */
/**
 * Codex's budget (utils/output-truncation, utils/string/truncate.rs): a 10k-token policy at ~4 bytes
 * per token, plus its 20% serialization allowance for what is saved in history = 48,000 UTF-8 bytes.
 */
export const RESULT_TOKEN_BUDGET = 10_000;
const APPROX_BYTES_PER_TOKEN = 4;
export const RESULT_TEXT_BUDGET = Math.round(RESULT_TOKEN_BUDGET * APPROX_BYTES_PER_TOKEN * 1.2);

/** A result above this is also retained whole as an output artifact (output-capture.ts); between the two it is only bounded. A paged `files.read` window (64KiB) stays below it. */
export const ARTIFACT_CAPTURE_THRESHOLD = 96_000;

/** Detail keys that mean the tool pages its own output and tells the model how to continue. */
const CONTINUATION_KEYS = ['nextStartLine', 'nextLineOffset', 'nextCursor', 'continuation', 'cursor'];

/** Conservative credential shapes a tool may echo; masked before it is journaled or shown. */
/**
 * The shared credential redaction seam. Keep this exported and behaviour-stable: the PH9 artifact
 * capture (a separate owner) reuses it so a persisted artifact is redacted by exactly the same rules
 * as the projected result, and a new pattern only ever needs to be added here.
 */
function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + '...[truncated]';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DETAIL_MAX_DEPTH = 3;
const DETAIL_MAX_ENTRIES = 50;

/** Redact every string at any depth and cap breadth/depth; drop only what cannot be represented. */
function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= DETAIL_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, DETAIL_MAX_ENTRIES).map((entry) => sanitizeDetails(entry, depth + 1));
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).slice(0, DETAIL_MAX_ENTRIES);
  return Object.fromEntries(entries.map(([key, entry]) => [key, sanitizeDetails(entry, depth + 1)]));
}

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');
const approxTokens = (bytes: number) => Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);

function textLength(content: ToolResult['content']): number {
  return content.reduce((total, block) => (block.type === 'text' ? total + utf8(block.text) : total), 0);
}

/** The first `bytes` bytes / the last `bytes` bytes of `text`, never splitting a character. */
function headBytes(text: string, bytes: number): string {
  return Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8').replace(/\uFFFD+$/, '');
}
function tailBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.subarray(Math.max(0, buffer.length - bytes)).toString('utf8').replace(/^\uFFFD+/, '');
}

/**
 * Codex's middle truncation, once, before the result enters the history: the text is cut to `budget`
 * UTF-8 bytes split evenly between head and tail, the middle replaced by `…N tokens truncated…`, and
 * a `Warning: truncated output (original token count: N)` / `Total output lines: N` header in front.
 * Images always survive untouched (Codex never drops an image on truncation).
 */
function clampBlocks(content: ToolResult['content'], budget: number): { content: ToolResult['content']; dropped: number } {
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const total = utf8(text);
  const headBudget = Math.floor(budget / 2);
  const head = headBytes(text, headBudget);
  const tail = tailBytes(text, budget - headBudget);
  const dropped = Math.max(0, total - utf8(head) - utf8(tail));
  const header = 'Warning: truncated output (original token count: ' + String(approxTokens(total)) + ')\nTotal output lines: ' + String(text.split('\n').length) + '\n\n';
  const body = header + head + '…' + String(approxTokens(dropped)) + ' tokens truncated…' + tail;
  return { content: [{ type: 'text', text: body }, ...content.filter((block) => block.type !== 'text')], dropped };
}

function declaresContinuation(details: Record<string, unknown> | undefined): boolean {
  return details !== undefined && CONTINUATION_KEYS.some((key) => details[key] !== undefined);
}

/** The bounded, redacted form of one tool result: safe to journal and to hand the model. */
export function projectResult(result: ToolResult): ToolResult {
  const content = result.content.map((block) =>
    block.type === 'text' ? { type: 'text' as const, text: redactText(block.text) } : block,
  );
  const sanitized = sanitizeDetails(result.details);
  const details = isRecord(sanitized) ? sanitized : undefined;
  if (declaresContinuation(result.details) || textLength(content) <= RESULT_TEXT_BUDGET) {
    return { ...result, content, ...(details === undefined ? {} : { details }) };
  }
  const bounded = clampBlocks(content, RESULT_TEXT_BUDGET);
  const notice = { type: 'text' as const, text: boundedNotice(bounded.dropped) };
  return {
    ...result,
    content: [...bounded.content, notice],
    details: {
      ...(details ?? {}),
      policyTruncation: {
        droppedBytes: bounded.dropped,
        keptBytes: RESULT_TEXT_BUDGET,
        hint: 'The result was bounded before it reached you. Request a narrower range, a smaller page or a specific section to read the rest; nothing was changed at the source.',
      },
    },
  };
}

/** The explicit, recoverable cut notice; never a bare ellipsis the model cannot act on. */
function boundedNotice(dropped: number): string {
  return '[result bounded by policy: about ' + String(approxTokens(dropped)) + ' tokens from the middle were not delivered. Request a narrower range, a smaller page or a specific section to read the rest.]';
}

const SUMMARY_LIMIT = 500;

/** A short bounded, redacted view for a step row. */
export function boundedSummary(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return clamp(redactText(text), SUMMARY_LIMIT);
}

/** Truthful step status for a result the model saw. */
export function stepStatusFor(result: ToolResult): StepStatus {
  return result.isError === true ? 'failed' : 'completed';
}

export function resultText(result: ToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
}

export function refusal(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The step text of a read-only tool the owner stopped mid-call: it was cancelled and nothing was changed. */
function stoppedReadReason(name: string): string {
  return `Tool ${name} was stopped before it finished. It only reads, so nothing was changed.`;
}

/** The kind a tool or the harness put on a failed result (`details.errorKind`), when it is one of the known kinds. */
function markedErrorKind(result: ToolResult): StepErrorKind | undefined {
  const parsed = stepErrorKindSchema.safeParse(result.details?.['errorKind']);
  return parsed.success ? parsed.data : undefined;
}

/** After-hook projection: truthful status plus a bounded, redacted summary of what happened, and why it failed. */
export function stepUpdate(outcome: ToolOutcome, step: Doc<'steps'>, startedAt: number, readOnly = false): Partial<Doc<'steps'>> {
  const durationMs = Date.now() - startedAt;
  if (outcome.kind === 'interrupted' || outcome.kind === 'cancelled') {
    // A stop cancels the request where the protocol can, but it cannot unsend one: a tool that changes things is reported as
    // unconfirmed ("may already have taken effect", with its fence kept for the recovery review). One that only reads has nothing to confirm.
    const stoppedRead = outcome.kind === 'cancelled' && readOnly;
    return { status: 'failed', durationMs, errorKind: outcome.kind === 'interrupted' ? 'harness' : 'other', output: { text: stoppedRead ? stoppedReadReason(step.target) : interruptedReason(step.target) } };
  }
  const marked = markedErrorKind(outcome.result);
  // A refusal before any effect is a policy or approval decision, except a call that did not fit the tool's schema: that one failed.
  const status: StepStatus = outcome.kind === 'refused' && marked !== 'validation' ? 'skipped' : stepStatusFor(outcome.result);
  const errorKind = status === 'completed' ? undefined : marked ?? (outcome.kind === 'refused' ? 'permission' : 'other');
  return { status, durationMs, ...(errorKind === undefined ? {} : { errorKind }), output: { summary: boundedSummary(resultText(outcome.result)) } };
}
