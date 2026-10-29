/**
 * files.edit — structured, exact-match editing on this agent's bound computer.
 *
 * The edit reads and writes only through the injected ComputerClient (ctx.agentId selects this
 * agent's own screen), never the host filesystem. The expected-content guard is read-then-write on
 * the sandbox, not an atomic compare-and-swap, so the tool reports a stale conflict instead of
 * claiming atomicity it cannot provide.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient } from '../computer/client.js';
import { computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { contentHash, countOccurrences, replaceOnce } from './codingHelpers.js';
import { resolveToolPath, type FileToolOptions } from './codingPath.js';
import { refuseProtectedHomePath, refuseServerReports } from './homeGuard.js';

const editSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  expectedHash: z.string().min(1).optional(),
  expectedContent: z.string().optional(),
  replaceAll: z.boolean().optional(),
  on: ON_SCHEMA,
});

export function createFileEditTool(opts: FileToolOptions): Tool {
  return {
    name: 'files.edit',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '' },
        oldText: { type: 'string', description: '' },
        newText: { type: 'string', description: '' },
        expectedHash: { type: 'string', description: '' },
        expectedContent: { type: 'string', description: '' },
        replaceAll: { type: 'boolean', description: '' },
        ...ON_PROPERTY,
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    // Editing commits bytes; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = editSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const path = await resolveToolPath(opts, ctx, parsed.path, parsed.on);
        const refused = refuseServerReports(path) ?? (parsed.on === 'mac' ? undefined : await refuseProtectedHomePath(opts, ctx, client, path));
        if (refused !== undefined) return refused;
        const current = await client.readFile(ctx.agentId, path, ctx.signal, parsed.on);
        const currentHash = contentHash(current.content);
        const stale = staleReason(parsed, current.content, currentHash);
        if (stale !== undefined) return refuse(path, 'stale', stale, { hash: currentHash });
        const occurrences = countOccurrences(current.content, parsed.oldText);
        if (occurrences === 0) {
          return refuse(path, 'not_found', `the text to replace was not found in ${path}`, { hash: currentHash });
        }
        if (occurrences > 1 && parsed.replaceAll !== true) {
          return refuse(path, 'ambiguous', `the text to replace appears ${occurrences} times in ${path}; make oldText unique or pass replaceAll:true`, { occurrences, hash: currentHash });
        }
        const nextContent = parsed.replaceAll === true
          ? current.content.split(parsed.oldText).join(parsed.newText)
          : replaceOnce(current.content, parsed.oldText, parsed.newText);
        const written = await client.writeFile(ctx.agentId, { path, content: nextContent }, ctx.signal, parsed.on);
        const replaced = parsed.replaceAll === true ? occurrences : 1;
        return {
          content: [{ type: 'text', text: `Edited ${written.path}: replaced ${replaced} occurrence(s)` }],
          details: {
            path: written.path,
            bytes: written.bytes,
            replaced,
            hash: contentHash(nextContent),
            previousHash: currentHash,
            guard: parsed.expectedHash !== undefined ? 'hash' : parsed.expectedContent !== undefined ? 'content' : 'none',
          },
        };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

function staleReason(
  parsed: { expectedHash?: string; expectedContent?: string },
  content: string,
  hash: string,
): string | undefined {
  if (parsed.expectedHash !== undefined && parsed.expectedHash !== hash) {
    return `file changed since read: current hash is ${hash}, expectedHash did not match`;
  }
  if (parsed.expectedContent !== undefined && parsed.expectedContent !== content) {
    return 'file changed since read: content did not match expectedContent';
  }
  return undefined;
}

function refuse(path: string, code: string, reason: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: `Refused edit of ${path}: ${reason}` }], isError: true, details: { path, code, ...details } };
}
