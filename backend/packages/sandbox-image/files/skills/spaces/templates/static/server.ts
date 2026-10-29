import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

// Serves public/ on the port the platform gave this app (PORT, or .juno-port), loopback only: the gateway is the way in.
const port = Number(process.env.PORT ?? readFileSync('.juno-port', 'utf8').trim());
const root = join(process.cwd(), 'public');

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const target = normalize(join(root, path.endsWith('/') ? path + 'index.html' : path));
    const file = Bun.file(target);
    if (!target.startsWith(root + '/') || !(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file);
  },
});
console.log(`listening on http://127.0.0.1:${port}`);
