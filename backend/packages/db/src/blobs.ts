/**
 * Blob store implementations (BACKEND §5.2a). `createBlobStore(env)` is the one place a process builds its store:
 *
 *  - `local` (default): one file per key under BLOB_DIR (default `<backend>/.data/blobs`; a relative BLOB_DIR is
 *    resolved against the backend root, so api and agentd, which run with different working directories, share it).
 *  - `s3`: any S3-compatible bucket, the same STORAGE_S3_ENDPOINT / _BUCKET / _ACCESS_KEY / _SECRET_KEY JuiceFS uses.
 *    Keys start with `blobs/`, which JuiceFS (one `juno-<hash>/` prefix per file system) never uses. Path-style requests
 *    signed with AWS Signature V4; BLOB_S3_REGION defaults to us-east-1 (R2 and MinIO accept it).
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlobStore } from '@agent-desktop/contracts';

const BACKEND_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Keys are `blobs/<sha256>`-like paths: plain segments only, never absolute or climbing out of the root. */
function checkKey(key: string): string {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) || key.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`invalid blob key: ${JSON.stringify(key)}`);
  }
  return key;
}

export function createLocalBlobStore(dir: string): BlobStore {
  const pathOf = (key: string): string => join(dir, checkKey(key));
  return {
    async put(key, bytes) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      // Write then rename: a reader never sees half a file, and two writers of the same content both end complete.
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, path);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export interface S3BlobSettings {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

const hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const encodeSegment = (part: string): string => encodeURIComponent(part).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * The AWS Signature V4 Authorization header for one request. `headers` are the lower-case headers to sign (host and
 * x-amz-* included); it must carry `x-amz-date` and `x-amz-content-sha256`. `query` is the canonical query string
 * (names sorted, names and values percent-encoded); empty for a request without one.
 */
export function sigV4Authorization(settings: Pick<S3BlobSettings, 'accessKey' | 'secretKey' | 'region'>, method: string, path: string, headers: Record<string, string>, query = ''): string {
  const amzDate = headers['x-amz-date'] ?? '';
  const day = amzDate.slice(0, 8);
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, ...names.map((name) => `${name}:${(headers[name] ?? '').trim()}`), '', names.join(';'), headers['x-amz-content-sha256'] ?? ''].join('\n');
  const scope = `${day}/${settings.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + settings.secretKey, day), settings.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${settings.accessKey}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`;
}

/** One signed path-style request: `path` is already encoded, `query` are the query parameters (signed in canonical order). */
function signedS3Request(settings: S3BlobSettings, fetchImpl: typeof fetch) {
  const base = new URL(settings.endpoint);
  return async (method: 'PUT' | 'GET' | 'DELETE', path: string, options: { body?: Uint8Array; mimeType?: string; query?: Record<string, string> } = {}): Promise<Response> => {
    const query = Object.entries(options.query ?? {}).map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join('&');
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-content-sha256': hex(options.body ?? ''),
      'x-amz-date': new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
      ...(options.mimeType === undefined ? {} : { 'content-type': options.mimeType }),
    };
    const { host: _host, ...sent } = headers;
    return fetchImpl(new URL(query === '' ? path : `${path}?${query}`, base), {
      method,
      headers: { ...sent, authorization: sigV4Authorization(settings, method, path, headers, query) },
      ...(options.body === undefined ? {} : { body: new Uint8Array(options.body) }),
    });
  };
}

export function createS3BlobStore(settings: S3BlobSettings, fetchImpl: typeof fetch = fetch): BlobStore {
  const send = signedS3Request(settings, fetchImpl);
  const request = (method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Uint8Array, mimeType?: string): Promise<Response> =>
    send(method, `/${encodeSegment(settings.bucket)}/${checkKey(key).split('/').map(encodeSegment).join('/')}`, { ...(body === undefined ? {} : { body }), ...(mimeType === undefined ? {} : { mimeType }) });
  const fail = async (what: string, key: string, response: Response): Promise<never> => {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`blob store ${what} ${key} failed: HTTP ${String(response.status)} ${detail}`);
  };
  return {
    async put(key, bytes, mimeType) {
      const response = await request('PUT', key, bytes, mimeType);
      if (!response.ok) await fail('put', key, response);
    },
    async get(key) {
      const response = await request('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) return fail('get', key, response);
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(key) {
      const response = await request('DELETE', key);
      if (!response.ok && response.status !== 404) await fail('delete', key, response);
    },
  };
}

const DELETE_PARALLEL = 16;
const xmlText = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Delete every object under `prefix` in the bucket (a user's JuiceFS file system, `juno-<hash>/`), page by page; returns how many
 * went. The prefix must be one plain top-level folder and every listed key is checked against it before it is deleted, so
 * nothing outside the folder (the shared `blobs/` included) can be touched. Running it again on an empty prefix deletes nothing.
 */
export async function deleteS3Prefix(settings: S3BlobSettings, prefix: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(prefix) || prefix === 'blobs/') throw new Error(`refusing to delete the object prefix ${JSON.stringify(prefix)}`);
  const send = signedS3Request(settings, fetchImpl);
  const bucketPath = `/${encodeSegment(settings.bucket)}`;
  let deleted = 0;
  let token: string | undefined;
  do {
    const listing = await send('GET', bucketPath, { query: { 'list-type': '2', prefix, ...(token === undefined ? {} : { 'continuation-token': token }) } });
    const xml = await listing.text();
    if (!listing.ok) throw new Error(`listing ${prefix} failed: HTTP ${String(listing.status)} ${xml.slice(0, 300)}`);
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => xmlText(match[1] ?? ''));
    for (let start = 0; start < keys.length; start += DELETE_PARALLEL) {
      await Promise.all(keys.slice(start, start + DELETE_PARALLEL).map(async (key) => {
        if (!key.startsWith(prefix)) throw new Error(`the bucket listed ${JSON.stringify(key)} outside ${prefix}; nothing more was deleted`);
        const response = await send('DELETE', `${bucketPath}/${key.split('/').map(encodeSegment).join('/')}`);
        if (!response.ok && response.status !== 404) throw new Error(`deleting ${key} failed: HTTP ${String(response.status)}`);
      }));
      deleted += Math.min(DELETE_PARALLEL, keys.length - start);
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    if (token !== undefined) token = xmlText(token);
  } while (token !== undefined);
  return deleted;
}

/** The blob store the environment asks for; throws a plain message when it is inconsistent. */
export function createBlobStore(env: NodeJS.ProcessEnv = process.env): BlobStore {
  const kind = env['BLOB_STORE'] ?? 'local';
  if (kind === 'local') {
    const dir = env['BLOB_DIR'] ?? '.data/blobs';
    return createLocalBlobStore(isAbsolute(dir) ? dir : resolve(BACKEND_ROOT, dir));
  }
  if (kind !== 's3') throw new Error(`BLOB_STORE must be local or s3, not ${JSON.stringify(kind)}`);
  const missing = ['STORAGE_S3_ENDPOINT', 'STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY'].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`BLOB_STORE=s3 needs ${missing.join(', ')}`);
  return createS3BlobStore({
    endpoint: env['STORAGE_S3_ENDPOINT'] ?? '',
    bucket: env['STORAGE_S3_BUCKET'] ?? '',
    accessKey: env['STORAGE_S3_ACCESS_KEY'] ?? '',
    secretKey: env['STORAGE_S3_SECRET_KEY'] ?? '',
    region: env['BLOB_S3_REGION'] ?? 'us-east-1',
  });
}
