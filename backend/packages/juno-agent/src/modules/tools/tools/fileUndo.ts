/**
 * The part of files.write / files.edit that makes them undoable (BACKEND 5.2d): before a file is replaced its current text is kept
 * (modules/files/history.ts). A copy that cannot be kept stops the write, so a replaced file is never lost without a way back.
 */
import type { ToolContext, ToolResult } from '../../../contracts/index.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import { currentText, keepPreviousVersion, type FileTarget } from '../../files/history.js';
import type { FileSnapshotTool } from '@agent-desktop/public-contracts';

export type KeptBeforeWrite =
  | { ok: true; snapshotId?: string; note: string }
  | { ok: false; refusal: ToolResult };

/**
 * Keep what `target` holds now. `known` is the text a tool has just read itself (files.edit), which saves a second read.
 * `note` is the words for the end of the tool's result; `snapshotId` goes into its details.
 */
export async function keepBeforeWrite(
  client: ComputerClient,
  ctx: ToolContext,
  target: FileTarget,
  tool: Extract<FileSnapshotTool, 'files.write' | 'files.edit'>,
  known?: string,
): Promise<KeptBeforeWrite> {
  const before = known ?? await currentText(client, ctx.agentId, target, ctx.signal);
  if (before === undefined) return { ok: true, note: '' };
  try {
    const origin = { agentId: ctx.agentId, runId: ctx.runId, conversationId: ctx.conversationId, ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }) };
    const kept = await keepPreviousVersion({ store: ctx.store, blobs: ctx.blobs }, origin, target, tool, before);
    if ('skipped' in kept) return { ok: true, note: ' (the old version is too large to keep a copy of)' };
    return { ok: true, snapshotId: kept.kept.id, note: ' (the old version is kept: files.restore brings it back)' };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { ok: false, refusal: { content: [{ type: 'text', text: `Nothing was written: the old version of ${target.path} could not be kept first (${error instanceof Error ? error.message : String(error)}).` }], isError: true } };
  }
}
