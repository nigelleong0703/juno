import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { saveBlob, loadBlob, type BlobStore } from '@agent-desktop/contracts';
import { createBlobStore, createLocalBlobStore, createS3BlobStore, deleteS3Prefix, sigV4Authorization } from '../blobs.js';

const bytes = Buffer.from([0, 255, 1, 128, 10, 13]);

/** What every implementation must do: content-addressed put, exact get, null for a missing key, idempotent delete. */
async function roundTrip(store: BlobStore): Promise<void> {
  const ref = await saveBlob(store, bytes, 'application/octet-stream');
  expect(ref).toEqual({ blobKey: 'blobs/' + createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, sha256: ref.sha256 });
  // The same content again is the same object.
  expect(await saveBlob(store, bytes, 'application/octet-stream')).toEqual(ref);
  expect(await store.get(ref.blobKey)).toEqual(bytes);
  expect(await loadBlob(store, ref)).toEqual({ ok: true, bytes });
  expect(await loadBlob(store, { ...ref, sizeBytes: 1 })).toEqual({ ok: false, reason: 'stored bytes do not match their recorded size' });
  expect(await loadBlob(store, { ...ref, sha256: '0'.repeat(64) })).toEqual({ ok: false, reason: 'stored bytes failed their integrity check' });
  expect(await store.get('blobs/missing')).toBeNull();
  await store.delete(ref.blobKey);
  await store.delete(ref.blobKey);
  expect(await store.get(ref.blobKey)).toBeNull();
  expect(await loadBlob(store, ref)).toEqual({ ok: false, reason: 'the stored file is missing' });
}

describe('local blob store', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'blobs-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('stores, reads and deletes by key, leaving no temp files', async () => {
    const store = createLocalBlobStore(dir);
    await roundTrip(store);
    await saveBlob(store, bytes, 'application/octet-stream');
    expect(await readdir(join(dir, 'blobs'))).toEqual([createHash('sha256').update(bytes).digest('hex')]);
  });

  it('refuses keys that could leave its directory', async () => {
    const store = createLocalBlobStore(dir);
    for (const key of ['../x', 'blobs/../../x', '/etc/passwd', 'blobs//x', '']) await expect(store.put(key, bytes, 'text/plain')).rejects.toThrow('invalid blob key');
  });

  it('is the default and resolves a relative BLOB_DIR against the backend root', async () => {
    const store = createBlobStore({ BLOB_DIR: dir });
    await roundTrip(store);
    expect(() => createBlobStore({ BLOB_STORE: 'gcs' })).toThrow('BLOB_STORE must be local or s3');
    expect(() => createBlobStore({ BLOB_STORE: 's3', STORAGE_S3_BUCKET: 'b' })).toThrow('BLOB_STORE=s3 needs STORAGE_S3_ENDPOINT, STORAGE_S3_ACCESS_KEY, STORAGE_S3_SECRET_KEY');
  });
});

describe('s3 request signing', () => {
  it('matches the AWS documented SigV4 example (GET Object, docs.aws.amazon.com sig-v4-header-based-auth)', () => {
    const authorization = sigV4Authorization(
      { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
      'GET', '/test.txt',
      { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    );
    expect(authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('matches the AWS documented SigV4 example with a query string (GET Bucket / List Objects)', () => {
    const authorization = sigV4Authorization(
      { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
      'GET', '/',
      { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      'max-keys=2&prefix=J',
    );
    expect(authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('deleting an object folder (account deletion)', () => {
  const settings = { endpoint: 'http://s3.test', bucket: 'files', accessKey: 'a', secretKey: 's', region: 'us-east-1' };

  /** A fake bucket that lists two keys per page, like a small MaxKeys, and records what was deleted. */
  function fakeBucket(keys: string[], listed: (all: string[]) => string[] = (all) => all) {
    const deleted: string[] = [];
    const lists: string[] = [];
    let matching: string[] = [];
    const fetchFake: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'DELETE') {
        deleted.push(decodeURIComponent(url.pathname.replace(/^\/files\//, '')));
        return new Response(null, { status: 204 });
      }
      lists.push(url.search);
      const prefix = url.searchParams.get('prefix') ?? '';
      const start = Number(url.searchParams.get('continuation-token') ?? '0');
      // Like a real bucket, the pages of one listing are a snapshot: deleting while paging does not shift the token.
      if (start === 0) matching = listed(keys.filter((key) => key.startsWith(prefix) && !deleted.includes(key)));
      const page = matching.slice(start, start + 2);
      const more = start + 2 < matching.length;
      return new Response(`<ListBucketResult>${page.map((key) => `<Contents><Key>${key.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${String(more)}</IsTruncated>${more ? `<NextContinuationToken>${String(start + 2)}</NextContinuationToken>` : ''}</ListBucketResult>`);
    };
    return { deleted, lists, fetchFake };
  }

  it('deletes every page of one folder and nothing outside it', async () => {
    const mine = Array.from({ length: 5 }, (_, index) => `juno-0123456789abcdef/chunks/${String(index)}`);
    const bucket = fakeBucket([...mine, 'juno-fedcba9876543210/chunks/0', 'blobs/' + 'a'.repeat(64), 'juno-0123456789abcdef-other/x']);
    expect(await deleteS3Prefix(settings, 'juno-0123456789abcdef/', bucket.fetchFake)).toBe(5);
    expect(bucket.deleted.sort()).toEqual(mine);
    expect(bucket.lists[0]).toBe('?list-type=2&prefix=juno-0123456789abcdef%2F');
    expect(bucket.lists[1]).toContain('continuation-token=');
    expect(await deleteS3Prefix(settings, 'juno-0123456789abcdef/', bucket.fetchFake)).toBe(0);
  });

  it('refuses anything that is not one plain top-level folder, and a listing that strays outside it', async () => {
    const bucket = fakeBucket(['juno-0123456789abcdef/a']);
    for (const prefix of ['', '/', 'blobs/', 'juno-0123456789abcdef', 'a/b/', '../', 'x y/']) {
      await expect(deleteS3Prefix(settings, prefix, bucket.fetchFake)).rejects.toThrow('refusing to delete the object prefix');
    }
    const lying = fakeBucket(['juno-0123456789abcdef/a', 'blobs/' + 'b'.repeat(64)], (all) => ['juno-0123456789abcdef/a', 'blobs/' + 'b'.repeat(64), ...all]);
    await expect(deleteS3Prefix(settings, 'juno-0123456789abcdef/', lying.fetchFake)).rejects.toThrow('outside juno-0123456789abcdef/');
    expect(lying.deleted.some((key) => key.startsWith('blobs/'))).toBe(false);
    expect(bucket.deleted).toEqual([]);
  });
});

describe('s3 blob store (fake S3)', () => {
  const objects = new Map<string, { body: Buffer; type: string | undefined }>();
  const seen: Array<{ method: string; url: string; authorization: string; contentSha: string; bodySha: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: String(req.headers.authorization), contentSha: String(req.headers['x-amz-content-sha256']), bodySha: createHash('sha256').update(body).digest('hex') });
      const key = req.url ?? '';
      if (req.method === 'PUT') { objects.set(key, { body, type: req.headers['content-type'] }); res.end(); return; }
      if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; res.end(); return; }
      const found = objects.get(key);
      if (found === undefined) { res.statusCode = 404; res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.end(found.body);
    });
  });
  let endpoint = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterEach(() => { seen.length = 0; });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('puts path-style objects under the bucket, signed with SigV4 over the exact payload', async () => {
    const store = createS3BlobStore({ endpoint, bucket: 'juno-files', accessKey: 'AKIDTEST', secretKey: 'secret', region: 'us-east-1' });
    await roundTrip(store);
    const put = seen.find((call) => call.method === 'PUT');
    expect(put?.url).toMatch(/^\/juno-files\/blobs\/[0-9a-f]{64}$/);
    expect(put?.contentSha).toBe(put?.bodySha);
    expect(put?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/s3\/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);
    expect([...objects.values()].every((object) => object.type === undefined || object.type === 'application/octet-stream')).toBe(true);
  });

  it('fails loudly on an error status instead of reporting a missing object', async () => {
    const store = createS3BlobStore({ endpoint: endpoint.replace(/:\d+$/, ':1'), bucket: 'b', accessKey: 'a', secretKey: 's', region: 'us-east-1' });
    await expect(store.get('blobs/x')).rejects.toThrow();
  });
});

// A real bucket: BLOB_S3_LIVE=1 with STORAGE_S3_ENDPOINT / _BUCKET / _ACCESS_KEY / _SECRET_KEY set.
describe.runIf(process.env['BLOB_S3_LIVE'] === '1')('s3 blob store (live bucket)', () => {
  it('round-trips against the configured bucket', async () => {
    await roundTrip(createBlobStore({ ...process.env, BLOB_STORE: 's3' }));
  });
});
