/**
 * files.restore — put back an earlier version of a text file that files.write or files.edit replaced (BACKEND 5.2d), so the owner can say
 * "undo that". With no `snapshotId` it restores the newest kept version of the path. What the restore replaces is kept too, so it can be undone.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient } from '../computer/client.js';
import { actionResult, computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { FileHistoryError, SNAPSHOTS_PER_PATH, historyOf, restoreSnapshot } from '../../files/history.js';
import { resolveToolPath, type FileToolOptions } from './codingPath.js';
import { refuseProtectedHomePath, refuseServerReports } from './homeGuard.js';

const restoreSchema = z.object({ path: z.string().min(1), snapshotId: z.string().min(1).optional(), on: ON_SCHEMA });

const refusal = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export function createFileRestoreTool(opts: FileToolOptions): Tool {
  return {
    name: 'files.restore',
    description: '',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '' }, snapshotId: { type: 'string', description: '' }, ...ON_PROPERTY },
      required: ['path'],
      additionalProperties: false,
    },
    // It writes a file; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = restoreSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const path = await resolveToolPath(opts, ctx, parsed.path, parsed.on);
        const refused = refuseServerReports(path) ?? (parsed.on === 'mac' ? undefined : await refuseProtectedHomePath(opts, ctx, client, path));
        if (refused !== undefined) return refused;
        const deps = { store: ctx.store, blobs: ctx.blobs };
        const history = await historyOf(deps, ctx.agentId, { path, on: parsed.on ?? 'sandbox' });
        const wanted = parsed.snapshotId === undefined ? history[0] : history.find((snapshot) => snapshot.id === parsed.snapshotId);
        if (wanted === undefined) {
          return refusal(`No earlier version of ${path} is kept${parsed.snapshotId === undefined ? '' : ' under that id'}. Only files.write and files.edit keep one (the last ${SNAPSHOTS_PER_PATH} per file, for 14 days); a shell command does not.`);
        }
        const origin = { runId: ctx.runId, conversationId: ctx.conversationId, ...(ctx.stepId === undefined ? {} : { stepId: ctx.stepId }) };
        const done = await restoreSnapshot({ ...deps, computer: client }, { snapshotId: wanted.id, agentId: ctx.agentId, origin, signal: ctx.signal });
        return actionResult(
          `Restored ${done.path} to the version from ${wanted.createdAt} (${done.bytes} byte(s)).${done.undo === undefined ? '' : ' What it replaced is kept: files.restore with snapshotId ' + done.undo.id + ' undoes this.'}`,
          { path: done.path, bytes: done.bytes, restored: wanted.id, ...(done.undo === undefined ? {} : { undo: done.undo.id }) },
        );
      } catch (error) {
        if (error instanceof FileHistoryError) return refusal(error.message);
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
