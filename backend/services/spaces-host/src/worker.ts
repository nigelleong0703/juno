/** The Worker entry (wrangler.toml `main`): every request goes to serve.ts. Errors answer 500 without detail. */
import { handleRequest, type HostedEnv } from './serve.js';

export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch {
      return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
  },
} satisfies ExportedHandler<HostedEnv>;
