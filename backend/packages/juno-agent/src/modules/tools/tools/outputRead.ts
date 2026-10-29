/**
 * output_read — page through an oversized tool result that was retained as an owner/agent-scoped
 * artifact. Pages are UTF-16-lossless (a window never splits a surrogate pair) and carry their own
 * cursor, so the model continues exactly where it stopped without re-running the side effect.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { readOutputArtifact, type ArtifactReadFailure } from '../outputArtifactReads.js';

const schema = z.object({
  ref: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
  maxChars: z.number().int().positive().optional(),
});

export function createOutputReadTool(): Tool {
  return {
    name: 'output_read',
    description: '',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'string' }, cursor: { type: 'number' }, maxChars: { type: 'number' } },
      required: ['ref'],
      additionalProperties: false,
    },
    // Reading a retained artifact changes nothing and is safe to redo after an interruption.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      const read = await readOutputArtifact(ctx.store, {
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        ref: parsed.ref,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        ...(parsed.maxChars === undefined ? {} : { maxChars: parsed.maxChars }),
      });
      if (typeof read === 'string') return failure(parsed.ref, read);
      const content: ToolResult['content'] = [{ type: 'text', text: read.text }];
      if (read.nextCursor < read.totalChars) content.push({ type: 'text', text: '[bounded: more remains; call output_read again with cursor=' + read.nextCursor + ']' });
      if (read.truncated) content.push({ type: 'text', text: '[the stored artifact is itself capped: only the first ' + read.totalChars + ' of ' + read.originalChars + ' characters were kept]' });
      return {
        content,
        details: { ref: read.ref, cursor: read.cursor, nextCursor: read.nextCursor, totalChars: read.totalChars, truncated: read.truncated, originalChars: read.originalChars, expiresAt: read.expiresAt },
      };
    },
  };
}

function failure(ref: string, reason: ArtifactReadFailure): ToolResult {
  const text =
    reason === 'denied' ? 'artifact ' + ref + ' is not available for this agent'
    : reason === 'expired' ? 'artifact ' + ref + ' has expired; the retained output is gone'
    : reason === 'bad_cursor' ? 'artifact ' + ref + ' was read with a cursor inside a character; use the cursor returned by the previous page'
    : 'artifact ' + ref + ' is not known (it may have been deleted or expired)';
  return { content: [{ type: 'text', text }], isError: true, details: { ref, artifact: reason } };
}
