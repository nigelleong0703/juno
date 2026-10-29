import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BRAND_ICON_FILES } from '../brand-icons.js';
import { createApiApp, type ApiAuth } from '../server.js';

const resolve = vi.fn(async () => ({ ownerId: 'owner-1' }));
const auth: ApiAuth = { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response('auth'), resolve };
const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:1', internalToken: 't' });

describe('brand icons', () => {
  it('serves a png or svg without a session, as a file name or a catalog id, with script-proof headers', async () => {
    for (const [path, type] of [['/v1/brand-icons/gmail.svg', 'image/svg+xml'], ['/v1/brand-icons/outlook-mail.svg', 'image/svg+xml'], ['/v1/brand-icons/gmail.png', 'image/png'], ['/v1/brand-icons/microsoft-todo.png', 'image/png']] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
      const body = Buffer.from(await response.arrayBuffer());
      expect(type === 'image/png' ? body.subarray(1, 4).toString() : body.toString()).toContain(type === 'image/png' ? 'PNG' : '<svg');
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('404s unknown names, other extensions, traversal and non-GET', async () => {
    for (const path of ['/v1/brand-icons/nope.svg', '/v1/brand-icons/gmail.gif', '/v1/brand-icons/..%2Fserver.ts', '/v1/brand-icons/%2e%2e%2f..%2fpackage.json.svg', '/v1/brand-icons/Gmail.svg']) {
      expect((await app.request(path)).status).toBe(404);
    }
    expect((await app.request('/v1/brand-icons/gmail.svg', { method: 'POST' })).status).toBeGreaterThanOrEqual(400);
  });

  it('every mapped file exists', () => {
    for (const file of new Set(Object.values(BRAND_ICON_FILES))) {
      for (const ext of ['svg', 'png']) expect(existsSync(new URL(`../../assets/brands/${file}.${ext}`, import.meta.url)), `${file}.${ext}`).toBe(true);
    }
  });
});

describe('agent avatars', () => {
  it('serves every character as a public PNG and nothing else', async () => {
    for (const character of ['bean', 'blue', 'mint', 'pink', 'purple', 'star']) {
      const response = await app.request(`/v1/agent-avatars/${character}.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
    }
    for (const path of ['/v1/agent-avatars/gmail.png', '/v1/agent-avatars/bean.svg', '/v1/agent-avatars/..%2Fbrands%2Fgmail.png']) {
      expect((await app.request(path)).status).toBe(404);
    }
  });
});
