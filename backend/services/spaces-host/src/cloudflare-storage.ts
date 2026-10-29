/**
 * The production storage of hosted Spaces: the Cloudflare REST API for the D1 database and the R2 bucket (BACKEND 5.12, option B).
 * It needs an API token with D1 edit and R2 object write on this account, and nothing else (see README). Failures never echo
 * the token.
 */
import { z } from 'zod';
import { HostedError, type HostedStorage, type SqlValue, type Statement } from './publisher.js';

export interface CloudflareStorageOptions {
  accountId: string;
  apiToken: string;
  databaseId: string;
  bucket: string;
  fetch?: typeof fetch;
}

const d1Answer = z.object({
  success: z.boolean(),
  result: z.array(z.object({ results: z.array(z.record(z.string(), z.unknown())).optional() })).optional(),
});

const r2List = z.object({
  success: z.boolean(),
  result: z.array(z.object({ key: z.string() })).optional(),
  result_info: z.object({ cursor: z.string().optional() }).optional(),
});

const API = 'https://api.cloudflare.com/client/v4';

export function cloudflareStorage(options: CloudflareStorageOptions): HostedStorage {
  const send = options.fetch ?? fetch;
  const account = `${API}/accounts/${encodeURIComponent(options.accountId)}`;
  const headers = { authorization: `Bearer ${options.apiToken}` };

  async function d1(sql: string, params: SqlValue[]): Promise<Array<Record<string, unknown>>> {
    const response = await send(`${account}/d1/database/${encodeURIComponent(options.databaseId)}/query`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const parsed = d1Answer.safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !parsed.success || !parsed.data.success) throw new HostedError('storage', `Cloudflare D1 answered ${String(response.status)}`);
    return parsed.data.result?.[0]?.results ?? [];
  }

  return {
    query: d1,

    async execute(statements: Statement[]) {
      // One request per statement: the REST query endpoint takes one statement at a time (see README for the consequences).
      for (const statement of statements) await d1(statement.sql, statement.params);
    },

    async putObject(key, body, contentType) {
      const response = await send(objectUrl(key), {
        method: 'PUT',
        headers: { ...headers, 'content-type': contentType },
        body,
      });
      if (!response.ok) throw new HostedError('storage', `Cloudflare R2 answered ${String(response.status)}`);
    },

    async deletePrefix(prefix) {
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ prefix, limit: '1000', ...(cursor === undefined ? {} : { cursor }) });
        const response = await send(`${account}/r2/buckets/${encodeURIComponent(options.bucket)}/objects?${query.toString()}`, { headers });
        const parsed = r2List.safeParse(await response.json().catch(() => undefined));
        if (!response.ok || !parsed.success || !parsed.data.success) throw new HostedError('storage', `Cloudflare R2 answered ${String(response.status)} to a listing`);
        for (const object of parsed.data.result ?? []) {
          const deleted = await send(objectUrl(object.key), { method: 'DELETE', headers });
          if (!deleted.ok) throw new HostedError('storage', `Cloudflare R2 answered ${String(deleted.status)} to a delete`);
        }
        cursor = parsed.data.result_info?.cursor ?? undefined;
      } while (cursor !== undefined && cursor !== '');
    },
  };

  function objectUrl(key: string): string {
    return `${account}/r2/buckets/${encodeURIComponent(options.bucket)}/objects/${encodeURIComponent(key)}`;
  }
}
