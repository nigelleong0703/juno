/**
 * computerd's home endpoints (BACKEND §5.2): the user's `/juno` files. They need only the VM binding, never a screen
 * or agent control, so a user editing a file or a sync running during a take-over still works, and a paused computer
 * is resumed first. Everything runs as root: `/juno` is not any agent user's to write. The owner comes from the owner-scoped app, not from a header the caller could choose.
 */
import type { Hono } from 'hono';
import { createSandboxHome, type SandboxHome } from '@agent-desktop/sandbox-adapters';
import { handle } from './http.js';
import type { ComputerdDeps } from './deps.js';
import { homeDeleteSchema, homeExtractTextSchema, homePathSchema, homePutFileSchema, homeSnapshotRequestSchema, homeWriteSchema } from './schema.js';

export function registerHomeRoutes(app: Hono, deps: ComputerdDeps): void {
  const post = (path: string, run: (home: SandboxHome, raw: unknown) => Promise<unknown>) =>
    app.post(path, (c) =>
      handle(c, async (signal) => {
        const raw = await c.req.json().catch(() => undefined);
        const binding = await deps.lifecycle.ensureComputer(signal);
        return Response.json(await deps.provider.withRuntime(binding, signal, (runtime) => run(createSandboxHome(runtime), raw), { user: 'root' }));
      }),
    );

  post('/v1/home/snapshot', (home, raw) => home.snapshot(homeSnapshotRequestSchema.parse(raw).agentId));
  post('/v1/home/read', async (home, raw) => (await home.read(homePathSchema.parse(raw).path)) ?? { missing: true });
  post('/v1/home/write', (home, raw) => {
    const input = homeWriteSchema.parse(raw);
    return home.write(input.path, input.content, input.expectedHash);
  });
  post('/v1/home/put-file', (home, raw) => {
    const input = homePutFileSchema.parse(raw);
    return home.put(input.path, Buffer.from(input.contentBase64, 'base64'));
  });
  post('/v1/home/extract-text', (home, raw) => {
    const input = homeExtractTextSchema.parse(raw);
    return home.extractText(input.path, input.format);
  });
  post('/v1/home/ensure', async (home, raw) => {
    await home.ensure(homePathSchema.parse(raw).path);
    return {};
  });
  post('/v1/home/delete', async (home, raw) => {
    const input = homeDeleteSchema.parse(raw);
    await home.delete(input.path, input.expectedHash);
    return {};
  });
}
