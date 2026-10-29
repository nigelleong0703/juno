/**
 * Same-origin web serving (WEB_DIST): client routes fall back to index.html, static assets keep
 * their content type, and the API surfaces are never answered with HTML.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';

const auth: ApiAuth = {
  info: { mode: 'account', providers: ['credential'] },
  handle: async () => new Response('auth', { status: 200 }),
  resolve: async () => ({ ownerId: 'owner-1' }),
};

let dist = '';

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-1.js'), 'export const a = 1;');
  writeFileSync(join(dist, 'assets', 'app-1.css'), 'body{}');
  writeFileSync(join(dist, 'assets', 'chunk-1.mjs'), 'export const b = 2;');
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

function app(webDist?: string): ReturnType<typeof createApiApp> {
  return createApiApp({ auth, agentdUrl: 'http://127.0.0.1:1', internalToken: 't', ...(webDist ? { webDist } : {}) });
}

describe('WEB_DIST serving', () => {
  it('serves index.html at / and for client routes', async () => {
    for (const path of ['/', '/agents/x']) {
      const response = await app(dist).request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('id="root"');
    }
  });

  it('serves static assets with their content type', async () => {
    const js = await app(dist).request('/assets/app-1.js');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toBe('export const a = 1;');
    const module = await app(dist).request('/assets/chunk-1.mjs');
    expect(module.headers.get('content-type')).toContain('text/javascript');
    const css = await app(dist).request('/assets/app-1.css');
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('does not answer a missing asset with the index, and a traversal never leaves the directory', async () => {
    expect((await app(dist).request('/assets/missing.js')).status).toBe(404);
    const escape = await app(dist).request('/..%2f..%2fetc/passwd');
    expect(await escape.text()).toContain('id="root"');
  });

  it('never swallows the API surfaces', async () => {
    const missing = await app(dist).request('/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No such route' } });
    expect((await app(dist).request('/healthz')).headers.get('content-type')).toContain('application/json');
    expect(await (await app(dist).request('/auth/anything')).text()).toBe('auth');
  });

  it('serves nothing when WEB_DIST is unset', async () => {
    const response = await app().request('/');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No such route' } });
  });
});
