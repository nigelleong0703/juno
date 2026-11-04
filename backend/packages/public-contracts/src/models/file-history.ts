import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/** Which of the agent's computers a file is on: its own sandbox, or the owner's Mac. */
export const fileHistoryComputerSchema = z.enum(['sandbox', 'mac']);
export type FileHistoryComputer = z.infer<typeof fileHistoryComputerSchema>;

/** What replaced the file: an agent's `files.write` or `files.edit`, or a restore (which keeps the bytes it replaced, so it can be undone too). */
export const fileSnapshotToolSchema = z.enum(['files.write', 'files.edit', 'files.restore']);
export type FileSnapshotTool = z.infer<typeof fileSnapshotToolSchema>;

/**
 * One earlier version of a text file an agent overwrote (BACKEND 5.2d): the bytes as they were just before the write. The bytes themselves
 * are never in this object; `POST /v1/files/restore` puts them back. Only `files.write` / `files.edit` leave one: a shell command does not.
 */
export const fileSnapshotSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  /** The file's absolute path on that computer. */
  path: z.string().min(1),
  on: fileHistoryComputerSchema,
  tool: fileSnapshotToolSchema,
  runId: idSchema.optional(),
  conversationId: idSchema.optional(),
  /** The durable step of the write that replaced these bytes. */
  stepId: z.string().min(1).optional(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().min(1),
  /** A restore only: the snapshot whose bytes were put back. */
  restoredFrom: idSchema.optional(),
  /** When the write happened. */
  createdAt: isoDateTimeSchema,
});
export type FileSnapshot = z.infer<typeof fileSnapshotSchema>;

/** `GET /v1/files/history?path=&agentId=&on=`: the kept versions of one path, newest first (at most 20, none older than 14 days). */
export const fileHistoryQuerySchema = z.object({
  path: z.string().min(1),
  agentId: idSchema,
  on: fileHistoryComputerSchema.default('sandbox'),
});
export type FileHistoryQuery = z.infer<typeof fileHistoryQuerySchema>;

export const fileHistorySchema = z.object({ items: z.array(fileSnapshotSchema) });
export type FileHistory = z.infer<typeof fileHistorySchema>;

/** `POST /v1/files/restore`: put a snapshot's bytes back at its path. */
export const restoreFileInputSchema = z.object({ snapshotId: idSchema });
export type RestoreFileInput = z.infer<typeof restoreFileInputSchema>;

export const restoredFileSchema = z.object({
  path: z.string().min(1),
  on: fileHistoryComputerSchema,
  bytes: z.number().int().min(0),
  /** The snapshot that was put back. */
  restored: fileSnapshotSchema,
  /** The bytes the restore replaced, kept as a new snapshot; absent when nothing was at the path. Restoring this one undoes the restore. */
  undo: fileSnapshotSchema.optional(),
});
export type RestoredFile = z.infer<typeof restoredFileSchema>;
