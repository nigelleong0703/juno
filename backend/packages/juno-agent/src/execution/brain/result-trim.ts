/**
 * Result trim (BACKEND §3.5.2b): old, large tool results stop riding along in every request.
 *
 * The cache-first rule is that the history only grows at its end. A trim therefore never happens per call. It is an epoch boundary like a
 * compaction: when the context crosses a share of the compaction trigger, the tool results older than the last few assistant turns and
 * bigger than a floor are replaced, ONCE, by a short stub that names the tool, its target and (when the harness kept the full output) the
 * `output_read` reference; the stubs are stored on a checkpoint row, so every request after the boundary shows the same ones. Between
 * boundaries the history is append-only again. The transcript rows are never edited: `output_read` and the replay see the original.
 */
import type { ResultTrim, TranscriptEntry } from '../../contracts/index.js';

/** The context share (of the compaction trigger) at which a trim may happen. */
export const TRIM_AT_SHARE = 0.6;
/** After a trim the next one waits until the context has grown by this much of the trigger. */
export const TRIM_NEXT_STEP = 0.1;
/** A result is kept whole while it is among the last assistant turns. */
export const KEEP_TURNS = 8;
/** Smaller results are not worth a stub. */
export const MIN_RESULT_CHARS = 2_000;
/** A result with no retained artifact keeps this much of its start next to the stub. */
const HEAD_CHARS = 1_000;
/** A trim has to give back at least this share of the compaction trigger, or it would break the cache for nothing. */
export const MIN_RECLAIM_SHARE = 0.05;
/** Characters per token for the reclaim estimate (the same rough ratio the context estimate uses). */
const CHARS_PER_TOKEN = 4;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text blocks of a tool result, joined; null when it carries an image (screenshots keep their own rule) or a loaded-tools list. */
function plainText(message: Record<string, unknown>): string | null {
  if (message['role'] !== 'toolResult' || message['loadedTools'] !== undefined || !Array.isArray(message['content'])) return null;
  const parts: string[] = [];
  for (const block of message['content']) {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return null;
    parts.push(block['text']);
  }
  return parts.join('\n');
}

const TARGET_KEYS = ['url', 'path', 'command', 'query', 'name'] as const;

/** What the call was about, in a few words: the first of url, path, command, query or name it carried. */
function targetOf(args: unknown): string {
  if (!isRecord(args)) return '';
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return '';
}

/** The tool a call really reached and its arguments: a `tool_call` proxy names the inner tool and carries the inner arguments. */
function callOf(entries: readonly TranscriptEntry[], toolCallId: string): { tool: string; args: unknown } | undefined {
  for (const entry of entries) {
    const content = entry.message['content'];
    if (entry.message['role'] !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'toolCall' || block['id'] !== toolCallId) continue;
      const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
      const args = block['arguments'];
      if (name === 'tool_call' && isRecord(args) && typeof args['name'] === 'string') return { tool: args['name'], args: args['arguments'] };
      return { tool: name, args };
    }
  }
  return undefined;
}

/** The reference of the artifact the harness kept for an oversized result (`artifactNotice`), if this result has one. */
function artifactRefOf(text: string): string | undefined {
  return /\[result retained as artifact (\S+) \(/.exec(text)?.[1];
}

/** The stub that stands for one result. With a retained artifact it is the whole replacement; without one the start of the result stays. */
export function stubFor(tool: string, target: string, text: string): string {
  const what = tool + (target === '' ? '' : ' ' + target) + ' (' + String(text.length) + ' characters)';
  const ref = artifactRefOf(text);
  if (ref !== undefined) return '[Earlier result trimmed to keep this conversation fast: ' + what + '. Read it again with output_read { ref: "' + ref + '", cursor: 0 }.]';
  return text.slice(0, HEAD_CHARS) + '\n[Earlier result trimmed to keep this conversation fast: ' + what + '; only its start is kept. Run the call again if you need the rest.]';
}

export interface TrimPlan {
  trims: ResultTrim[];
  /** Estimated tokens the stubs give back. */
  reclaimedTokens: number;
}

/**
 * Which results to stub now. `rows` are the projected transcript rows after the last checkpoint, oldest first; `already` are the seqs that
 * are stubs already. A result is eligible when more than `KEEP_TURNS` assistant turns follow it, it is plain text above the floor, and it
 * is not already a stub.
 */
export function planTrim(rows: readonly TranscriptEntry[], already: ReadonlySet<number>): TrimPlan {
  let seen = 0;
  let boundary = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.message['role'] !== 'assistant') continue;
    seen += 1;
    if (seen === KEEP_TURNS) { boundary = index; break; }
  }
  const trims: ResultTrim[] = [];
  let reclaimedChars = 0;
  for (let index = 0; index < boundary; index += 1) {
    const entry = rows[index];
    if (entry === undefined || already.has(entry.seq)) continue;
    const text = plainText(entry.message);
    if (text === null || text.length <= MIN_RESULT_CHARS) continue;
    const toolCallId = entry.message['toolCallId'];
    const call = typeof toolCallId === 'string' ? callOf(rows.slice(0, index), toolCallId) : undefined;
    const tool = call?.tool ?? (typeof entry.message['toolName'] === 'string' ? entry.message['toolName'] : 'tool');
    const stub = stubFor(tool, targetOf(call?.args), text);
    if (stub.length >= text.length) continue;
    trims.push({ seq: entry.seq, stub });
    reclaimedChars += text.length - stub.length;
  }
  return { trims, reclaimedTokens: Math.floor(reclaimedChars / CHARS_PER_TOKEN) };
}

/**
 * The rows as the projection shows them: each trimmed result carries its stub
 * instead of its text. A stubbed row is stamped with the boundary timestamp
 * (the checkpoint's creation time), so a provider measurement taken before
 * the trim is older than the rewritten prefix and the SDK drops it, while a
 * measurement taken after stays valid. Persisted transcript rows are never
 * edited: only the projected copy carries the stub and the stamp.
 */
export function applyTrims(rows: TranscriptEntry[], trims: readonly ResultTrim[] | undefined, boundaryTimestamp?: number): TranscriptEntry[] {
  if (trims === undefined || trims.length === 0) return rows;
  const stubs = new Map(trims.map((trim) => [trim.seq, trim.stub]));
  const boundary = boundaryTimestamp !== undefined && Number.isFinite(boundaryTimestamp) ? boundaryTimestamp : undefined;
  return rows.map((entry) => {
    const stub = stubs.get(entry.seq);
    if (stub === undefined || entry.message['role'] !== 'toolResult') return entry;
    const original = entry.message;
    const stamped = typeof original['timestamp'] === 'number' && boundary !== undefined
      ? Math.max(original['timestamp'], boundary)
      : original['timestamp'];
    return { ...entry, message: { ...original, content: [{ type: 'text', text: stub }], timestamp: stamped } };
  });
}
