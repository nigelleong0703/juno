/**
 * The local storage of the publisher: the D1 database and R2 bucket of a `wrangler dev` (wrangler.dev.toml), reached through its
 * development admin endpoints (dev-admin.ts). It is what tests and a developer's machine publish with; production uses
 * cloudflare-storage.ts. A publish's statements run as one D1 batch, so it is atomic here as in the binding.
 */
import { z } from 'zod';
import { HostedError, type HostedStorage, type SqlValue, type Statement } from './publisher.js';

const queryAnswer = z.object({ results: z.array(z.record(z.string(), z.unknown())) });

export interface LocalStorageOptions {
  /** The `wrangler dev` address, e.g. http://127.0.0.1:8799 */
  baseUrl: string;
  /** The ADMIN_TOKEN the dev Worker was started with (wrangler.dev.toml). */
  adminToken: string;
  fetch?: typeof fetch;
}

export function devStorage(options: LocalStorageOptions): HostedStorage {
  const send = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '') + '/__admin/';
  const headers = { authorization: `Bearer ${options.adminToken}`, 'content-type': 'application/json' };

  async function call(path: string, body: unknown): Promise<unknown> {
    const response = await send(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new HostedError('storage', `the local Worker answered ${String(response.status)} to ${path}`);
    return response.json();
  }

  return {
    async query(sql: string, params: SqlValue[]) {
      const answer = queryAnswer.safeParse(await call('d1/query', { sql, params }));
      if (!answer.success) throw new HostedError('storage', 'the local Worker sent no rows');
      return answer.data.results;
    },

    async execute(statements: Statement[]) {
      await call('d1/batch', { statements });
    },

    async putObject(key, body, contentType) {
      const response = await send(base + 'r2/' + encodeURIComponent(key), { method: 'PUT', headers: { authorization: headers.authorization, 'content-type': contentType }, body });
      if (!response.ok) throw new HostedError('storage', `the local Worker answered ${String(response.status)} to an object write`);
    },

    async deletePrefix(prefix) {
      await call('r2/delete-prefix', { prefix });
    },
  };
}
