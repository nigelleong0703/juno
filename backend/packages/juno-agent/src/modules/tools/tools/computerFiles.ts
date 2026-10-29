/** files.read / files.write — read (bounded, line-ranged) and write files on this agent's bound computer. */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  requireComputerClient,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { resolveToolPath } from './codingPath.js';
import { refuseHomeRead, refuseProtectedHomePath, refuseServerReports, visibleFileText } from './homeGuard.js';
import { actionResult, computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import {
  DEFAULT_READ_LINES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  contentHash,
  readWindow,
} from './codingHelpers.js';
import type { ReadWindow } from './codingHelpers.js';

const readSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  lineOffset: z.number().int().min(0).optional(),
  maxLines: z.number().int().min(1).optional(),
  maxBytes: z.number().int().min(1).optional(),
  on: ON_SCHEMA,
});
const writeSchema = z.object({ path: z.string().min(1), content: z.string(), on: ON_SCHEMA });

export function createFileReadTool(opts: {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}): Tool {
  return {
    name: 'files.read',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '' },
        startLine: { type: 'integer', minimum: 1, description: '' },
        lineOffset: { type: 'integer', minimum: 0, description: '' },
        maxLines: { type: 'integer', minimum: 1, description: '' },
        maxBytes: { type: 'integer', minimum: 1, description: '' },
        ...ON_PROPERTY,
      },
      required: ['path'],
      additionalProperties: false,
    },
    // Reading is safe to redo after an interruption.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = readSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const path = await resolveToolPath(opts, ctx, parsed.path, parsed.on);
        const refused = refuseServerReports(path) ?? (parsed.on === 'mac' ? undefined : await refuseHomeRead(opts, ctx, path));
        if (refused !== undefined) return refused;
        // The client returns the whole file; the bound below limits the text handed to the model, not
        // the sandbox transfer. Byte-exact continuation keeps paging lossless when that bound bites.
        const file = await client.readFile(ctx.agentId, path, ctx.signal, parsed.on);
        // A person page shows this agent its own sections only (the other agents' private lines are left out, BACKEND 5.7.4).
        const window = readWindow(visibleFileText(path, file.content, ctx.agentId), {
          startLine: parsed.startLine ?? 1,
          lineOffset: parsed.lineOffset ?? 0,
          maxLines: Math.min(parsed.maxLines ?? DEFAULT_READ_LINES, MAX_READ_LINES),
          maxBytes: Math.min(parsed.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES),
        });
        const content: ToolResult['content'] = [{ type: 'text', text: window.text }];
        if (window.truncated) content.push({ type: 'text', text: continuationNote(window) });
        return {
          content,
          details: {
            path,
            bytes: file.bytes,
            hash: contentHash(file.content),
            startLine: window.startLine,
            startLineOffset: window.startLineOffset,
            endLine: window.endLine,
            nextStartLine: window.nextStartLine,
            nextLineOffset: window.nextLineOffset,
            totalLines: window.totalLines,
            totalBytes: window.totalBytes,
            truncated: window.truncated,
          },
        };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

/** Tell the model exactly how much it got and the byte-exact continuation to page the rest. */
function continuationNote(window: ReadWindow): string {
  const shown = window.endLine === null
    ? `${Buffer.byteLength(window.text)} byte(s) of line ${window.startLine}`
    : `lines ${window.startLine}-${window.endLine}`;
  return `[truncated after ${shown} of ${window.totalLines} lines / ${window.totalBytes} bytes; continue with startLine=${window.nextStartLine}, lineOffset=${window.nextLineOffset}]`;
}

export function createFileWriteTool(opts: {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}): Tool {
  return {
    name: 'files.write',
    description: '',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '' }, content: { type: 'string', description: '' }, ...ON_PROPERTY },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    // Writing a file is a committed side effect; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = writeSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const path = await resolveToolPath(opts, ctx, parsed.path, parsed.on);
        const refused = refuseServerReports(path) ?? (parsed.on === 'mac' ? undefined : await refuseProtectedHomePath(opts, ctx, client, path));
        if (refused !== undefined) return refused;
        const written = await client.writeFile(ctx.agentId, { path, content: parsed.content }, ctx.signal, parsed.on);
        return actionResult(`Wrote ${written.bytes} byte(s) to ${written.path}`, { path: written.path, bytes: written.bytes });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
