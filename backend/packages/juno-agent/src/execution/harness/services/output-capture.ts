/**
 * The after-hook output capture (PH9). It runs BEFORE the projection bounds a result: an oversized
 * generic body, or an MCP result whose private fullContent detail was withheld, is retained in the
 * owner/agent-scoped artifact store and replaced by a bounded notice with a real reference. The
 * projection then bounds and redacts what remains, so no private body ever reaches the transcript,
 * a step row or the model context. The capture path is also the scheduled expiry-cleanup point.
 */
import type { Store, ToolResult } from '../../../contracts/index.js';
import { artifactNotice, captureOutputArtifact, PRIVATE_DETAIL_KEYS } from '../../../modules/tools/outputArtifacts.js';
import { cleanupExpiredArtifacts } from '../../../modules/tools/outputArtifactReads.js';
import { ARTIFACT_CAPTURE_THRESHOLD, redactText, resultText } from './tool-projection.js';

export interface OutputCaptureContext {
  ownerId: string;
  agentId: string;
  runId: string;
  stepId: string;
  tool: string;
}

export async function captureOversizedResult(store: Store, context: OutputCaptureContext, result: ToolResult, signal?: AbortSignal): Promise<ToolResult> {
  const privateText = privateDetail(result.details);
  const oversized = textLength(result.content) > ARTIFACT_CAPTURE_THRESHOLD;
  // A stopping run must not write a late artifact; the projection still bounds what the model sees.
  if (signal?.aborted || (privateText === undefined && !oversized)) return result;
  const captured = await captureOutputArtifact(
    store,
    {
      ownerId: context.ownerId,
      agentId: context.agentId,
      runId: context.runId,
      stepId: context.stepId,
      tool: context.tool,
      text: privateText ?? resultText(result),
      redact: redactText,
    },
    signal,
  );
  // The capture path is where expiry is enforced: bounded, owner-scoped, never on a read.
  await cleanupExpiredArtifacts(store, { ownerId: context.ownerId }).catch(() => undefined);
  // The notice goes FIRST and the oversized body is replaced by a bounded head: the projection drops
  // from the END, so a notice appended after a huge body would itself be clipped away.
  const head = oversized ? headContent(result.content, ARTIFACT_HEAD_CHARS) : result.content;
  return {
    ...result,
    content: [{ type: 'text', text: artifactNotice(captured, context.tool) }, ...head],
    details: { ...(stripPrivate(result.details) ?? {}), artifactRef: captured.ref, artifactChars: captured.chars, artifactTruncated: captured.truncated },
  };
}

/** The text a background result reports: its withheld private detail when there is one, else its text blocks. */
export function backgroundResultText(result: ToolResult): string {
  return privateDetail(result.details) ?? resultText(result);
}

/**
 * The redacted summary a background result or watcher reports (H-72/H-73), with the same redaction the
 * foreground path applies. Text that fits is returned whole. A longer one is kept whole as an output
 * artifact, and the summary shows its head and tail with the reference, so nothing is cut blindly.
 */
export async function reportSummary(store: Store, context: OutputCaptureContext, text: string, maxChars: number): Promise<string> {
  const clean = redactText(text);
  if (clean.length <= maxChars) return clean;
  const captured = await captureOutputArtifact(store, { ownerId: context.ownerId, agentId: context.agentId, runId: context.runId, stepId: context.stepId, tool: context.tool, text: clean });
  const head = Math.ceil(maxChars * 0.6);
  return clean.slice(0, head) + '\n...\n' + clean.slice(clean.length - (maxChars - head)) + '\n' + artifactNotice(captured, context.tool);
}

/** How much of an oversized body is still shown inline; the rest lives in the artifact. */
const ARTIFACT_HEAD_CHARS = 2_000;

/** A bounded head of the text blocks; image blocks always survive. */
function headContent(content: ToolResult['content'], maxChars: number): ToolResult['content'] {
  const kept: ToolResult['content'] = [];
  let used = 0;
  for (const block of content) {
    if (block.type !== 'text') {
      kept.push(block);
      continue;
    }
    const room = maxChars - used;
    // Text stops once the head is full, but a later image block still survives (never dropped).
    if (room <= 0) continue;
    kept.push(room >= block.text.length ? block : { type: 'text', text: block.text.slice(0, room) });
    used += Math.min(room, block.text.length);
  }
  return kept;
}

function privateDetail(details: Record<string, unknown> | undefined): string | undefined {
  if (details === undefined) return undefined;
  for (const key of PRIVATE_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** The private field is removed entirely: only the reference survives into details. */
function stripPrivate(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (PRIVATE_DETAIL_KEYS.includes(key)) continue;
    kept[key] = value;
  }
  return kept;
}

function textLength(content: ToolResult['content']): number {
  return content.reduce((total, block) => (block.type === 'text' ? total + block.text.length : total), 0);
}
