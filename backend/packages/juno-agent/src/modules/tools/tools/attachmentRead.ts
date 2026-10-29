// attachment_read: page through a text file the user attached when it was too long to inline. The id comes
// from the message; the read is scoped to the requesting owner, so any other id is simply not found.
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { decodeText, loadAttachment, MAX_INLINE_TEXT_CHARS, neutralize, sniffImageMime } from '../../attachments/index.js';

const attachmentReadSchema = z.object({
  id: z.string().min(1),
  /** 0-based character offset into the file's text. */
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_INLINE_TEXT_CHARS).optional(),
});

function error(text: string): ToolResult {
  return { content: [{ type: 'text', text: 'Error: ' + text }], isError: true };
}

export function createAttachmentReadTool(): Tool {
  return {
    name: 'attachment_read',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '' },
        offset: { type: 'number', description: '' },
        limit: { type: 'number', description: '' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = attachmentReadSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('attachment_read', args, parsed.error);
      const lookup = await loadAttachment(ctx.store, ctx.blobs, ctx.ownerId, parsed.data.id);
      if (lookup.status === 'unavailable') return error('attachment ' + JSON.stringify(parsed.data.id) + ' is unavailable: ' + lookup.reason + '.');
      const { file } = lookup;
      if (sniffImageMime(file.bytes) !== undefined) return error('this is an image; it is already shown in the user message.');
      const text = decodeText(file.bytes);
      if (text === undefined) return error('this is a binary file; its content cannot be read.');
      const offset = parsed.data.offset ?? 0;
      const limit = parsed.data.limit ?? MAX_INLINE_TEXT_CHARS;
      const slice = text.slice(offset, offset + limit);
      const end = offset + slice.length;
      const next = end < text.length ? ` Continue with offset=${String(end)}.` : ' End of file.';
      return {
        content: [{ type: 'text', text: `[characters ${String(offset)}-${String(end)} of ${String(text.length)}.${next}]\n<untrusted>${neutralize(slice)}</untrusted>` }],
        details: { id: file.id, offset, end, total: text.length },
      };
    },
  };
}
