/** Owner library: list, read, pin and delete saved artifacts. */
import type { Context, Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, uploadInputSchema } from '@agent-desktop/public-contracts';
import { createAppRepository } from '../app-repository.js';
import { requestOwner } from '../owner.js';
import { parseListQuery } from './list-query.js';
import type { AppRoutesDeps } from './index.js';

const pinnedInputSchema = z.object({ pinned: z.boolean() });

/** Base64 inflates a file by a third; the JSON envelope adds a little. Bigger bodies are refused before they are read. */
const MAX_UPLOAD_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4096;

const tooLarge = { error: { code: 'FILE_TOO_LARGE', message: 'Upload exceeds the ' + String(MAX_UPLOAD_BYTES) + ' byte limit' } };

const libraryListQuerySchema = z.object({
  conversationId: z.string().min(1).max(256).optional(),
});

export function registerLibrary(app: Hono, deps: AppRoutesDeps): void {
  const repo = (c: Context) => createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);

  app.get('/v1/library', async (c) => {
    const raw = c.req.query();
    const scope = libraryListQuerySchema.parse(raw);
    const base = parseListQuery(raw);
    const page = await repo(c).library.list(
      scope.conversationId === undefined
        ? base
        : { ...base, where: { ...base.where, conversationId: scope.conversationId } },
    );
    // Approval screenshots are evidence for a request card, not the user's files: they stay readable by id only.
    const items = page.items.filter((item) => !(item.tags ?? []).includes('approval-preview'));
    return c.json({ items, nextCursor: page.nextCursor ?? null });
  });

  app.get('/v1/library/:id', async (c) => {
    const item = await repo(c).library.get(c.req.param('id'));
    if (!item) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'library ' + c.req.param('id') + ' not found' } }, 404);
    }
    return c.json(item);
  });

  app.get('/v1/library/:id/download', async (c) => {
    const result = await repo(c).library.download(c.req.param('id'));
    if (result.status === 'not_found') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'library ' + c.req.param('id') + ' not found' } }, 404);
    }
    if (result.status === 'unavailable') {
      return c.json({ error: { code: 'FILE_UNAVAILABLE', message: result.reason } }, 404);
    }
    return c.json(result.file);
  });

  // The composer's attachment: one JSON body {name, mimeType, contentBase64}; the reply is the Attachment
  // to send on the message. The file is a library row (source 'upload'), so it also shows in the user's files.
  app.post(
    '/v1/uploads',
    async (c, next) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BODY_BYTES) return c.json(tooLarge, 413);
      await next();
    },
    zValidator('json', uploadInputSchema),
    async (c) => {
      const result = await repo(c).library.upload(c.req.valid('json'), requestOwner(c));
      if (result.status === 'too_large') return c.json(tooLarge, 413);
      if (result.status === 'invalid') {
        return c.json({ error: { code: 'INVALID_UPLOAD', message: result.reason } }, 400);
      }
      return c.json(result.attachment, 201);
    },
  );

  app.post('/v1/library/:id/pinned', zValidator('json', pinnedInputSchema), async (c) => {
    const item = await repo(c).library.setPinned(c.req.param('id'), c.req.valid('json').pinned);
    return c.json(item);
  });

  app.delete('/v1/library/:id', async (c) => {
    await repo(c).library.remove(c.req.param('id'));
    return c.json({});
  });
}
