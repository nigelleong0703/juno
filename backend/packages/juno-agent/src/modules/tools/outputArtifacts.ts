/**
 * Owner/agent-scoped storage for oversized tool output (PH9) — the capture side.
 *
 * The harness captures a result's full REDACTED text before the projection clips it, stores it here
 * (never in the prompt transcript) and hands the model a bounded notice with a reference; the
 * `output_read` tool pages that reference back losslessly (see outputArtifactReads.ts). Capture is
 * idempotent per (owner, run, step), so a replay reuses one artifact and never re-runs the side
 * effect. A hard character cap bounds one artifact — when the original exceeded it the artifact says
 * so instead of pretending to be whole — and expiry is enforced by a bounded cleanup, not by reads.
 */
import { createHash } from 'node:crypto';
import type { OutputArtifact, Store } from '../../contracts/index.js';

export const ARTIFACT_CHAR_CAP = 400_000;
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CaptureArtifactInput {
  ownerId: string;
  agentId: string;
  runId: string;
  stepId: string;
  tool: string;
  /** The FULL text, captured before any projection clipping. */
  text: string;
  /** Applied before storage (the projection's redaction seam); omitted only when already redacted. */
  redact?: (text: string) => string;
}

export interface CapturedArtifact {
  ref: string;
  chars: number;
  bytes: number;
  originalChars: number;
  truncated: boolean;
  expiresAt: string;
}

export interface CapturedDetails {
  details: Record<string, unknown> | undefined;
  artifactRef?: string;
}

/**
 * Detail keys that carry a tool's PRIVATE full body. They must never reach the transcript or a step
 * row: the body goes to the artifact store and the details keep only the reference.
 */
export const PRIVATE_DETAIL_KEYS: string[] = ['fullContent'];

/** Deterministic id: the same step reuses its artifact instead of writing a second one. */
export function artifactId(input: { ownerId: string; runId: string; stepId: string }): string {
  return 'art_' + createHash('sha256').update(input.ownerId + '|' + input.runId + '|' + input.stepId).digest('hex').slice(0, 24);
}

export async function captureOutputArtifact(store: Store, input: CaptureArtifactInput, signal?: AbortSignal): Promise<CapturedArtifact> {
  const id = artifactId(input);
  const existing = await store.get('artifacts', id);
  // Replay: the same step keeps its artifact (and its reference) and writes nothing new.
  if (existing !== null && existing.ownerId === input.ownerId) return captured(existing);
  // A cancelled run must never write a late canonical artifact.
  if (signal?.aborted) throw new Error('artifact capture cancelled before any write');
  const redacted = input.redact === undefined ? input.text : input.redact(input.text);
  const originalChars = redacted.length;
  const kept = safeCapEnd(redacted, ARTIFACT_CHAR_CAP);
  const text = kept === originalChars ? redacted : redacted.slice(0, kept);
  const now = new Date();
  const artifact: OutputArtifact = {
    id,
    ownerId: input.ownerId,
    agentId: input.agentId,
    runId: input.runId,
    stepId: input.stepId,
    tool: input.tool,
    text,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    originalChars,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    truncated: kept < originalChars,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ARTIFACT_TTL_MS).toISOString(),
  };
  await store.put('artifacts', artifact);
  return captured(artifact);
}

/**
 * Move a private full-content detail into the artifact store and return the details WITHOUT it, so
 * the transcript and step rows only ever see the reference. Non-private details are preserved.
 */
export async function capturePrivateDetails(
  store: Store,
  input: { ownerId: string; agentId: string; runId: string; stepId: string; tool: string; details?: Record<string, unknown>; redact?: (text: string) => string },
  signal?: AbortSignal,
): Promise<CapturedDetails> {
  const details = input.details;
  if (details === undefined) return { details: undefined };
  const privateText = privateTextOf(details);
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (PRIVATE_DETAIL_KEYS.includes(key)) continue;
    stripped[key] = value;
  }
  if (privateText === undefined) return { details: stripped };
  const capturedArtifact = await captureOutputArtifact(
    store,
    {
      ownerId: input.ownerId,
      agentId: input.agentId,
      runId: input.runId,
      stepId: input.stepId,
      tool: input.tool,
      text: privateText,
      ...(input.redact === undefined ? {} : { redact: input.redact }),
    },
    signal,
  );
  return {
    details: { ...stripped, artifactRef: capturedArtifact.ref, artifactChars: capturedArtifact.chars, artifactTruncated: capturedArtifact.truncated },
    artifactRef: capturedArtifact.ref,
  };
}

/** The explicit notice the model sees instead of the clipped body. */
export function artifactNotice(capturedArtifact: CapturedArtifact, tool: string): string {
  const capped = capturedArtifact.truncated
    ? ' The stored copy is itself capped at ' + String(capturedArtifact.chars) + ' of ' + String(capturedArtifact.originalChars) + ' characters.'
    : '';
  return '[result retained as artifact ' + capturedArtifact.ref + ' (' + String(capturedArtifact.chars) + ' characters from ' + tool + '); too large to deliver in full. Read it with output_read { ref: "' + capturedArtifact.ref + '", cursor: 0 }.' + capped + ']';
}

function privateTextOf(details: Record<string, unknown>): string | undefined {
  for (const key of PRIVATE_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function captured(artifact: OutputArtifact): CapturedArtifact {
  return { ref: artifact.id, chars: artifact.chars, bytes: artifact.bytes, originalChars: artifact.originalChars, truncated: artifact.truncated, expiresAt: artifact.expiresAt };
}

/** Never store a dangling high surrogate: a cap that lands mid-pair keeps the pair out. */
function safeCapEnd(text: string, cap: number): number {
  if (text.length <= cap) return text.length;
  const code = text.charCodeAt(cap - 1);
  return code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap;
}
