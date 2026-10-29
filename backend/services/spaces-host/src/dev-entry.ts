/**
 * The entry of `wrangler dev` (wrangler.dev.toml): the production Worker plus the development admin endpoints the local
 * publisher writes through. Production deploys use src/worker.ts (wrangler.toml), which has no admin endpoints.
 */
import { handleAdmin, isAdminPath, type DevEnv } from './dev-admin.js';
import { handleRequest, type HostedEnv } from './serve.js';

export default {
  async fetch(request: Request, env: DevEnv & HostedEnv): Promise<Response> {
    if (isAdminPath(new URL(request.url).pathname)) return handleAdmin(request, env);
    try {
      return await handleRequest(request, env);
    } catch {
      return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
  },
} satisfies ExportedHandler<DevEnv & HostedEnv>;
