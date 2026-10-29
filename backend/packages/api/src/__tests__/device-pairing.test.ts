import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { startScratchPostgres, type ScratchPostgres } from '@agent-desktop/db/testing/scratch-postgres';
import { createAccountAuth } from '../account-auth.js';

const SECRET = 'test-secret-that-is-long-enough-32-chars';
const BASE = 'http://127.0.0.1:8787';

let cluster: ScratchPostgres;
let pool: Pool | undefined;

beforeAll(async () => {
  cluster = await startScratchPostgres();
}, 240_000);

afterAll(async () => {
  await cluster?.close();
});

async function setup() {
  // A migrated database of its own: sign-ups keep their rows, so each test gets a fresh one.
  pool = new Pool({ connectionString: await cluster.newDatabase(), connectionTimeoutMillis: 5000 });
  const auth = createAccountAuth({ secret: SECRET, baseURL: BASE, database: pool });
  // Native clients send no Origin header and carry the session as a bearer token.
  const call = async (path: string, init: { body?: unknown; token?: string; method?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.token) headers['authorization'] = `Bearer ${init.token}`;
    const res = await auth.handler(new Request(`${BASE}/auth${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }));
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { call };
}

describe('watch pairing (device authorization)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(async () => {
    vi.useRealTimers();
    await pool?.end();
    pool = undefined;
  });

  it('a signed-in phone approves a code and the watch receives a session for the same account', async () => {
    const { call } = await setup();
    const phone = await call('/sign-up/email', { body: { email: 'owner@example.com', password: 'correct-horse-battery', name: 'Owner' } });
    const phoneToken = phone.json['token'] as string;
    expect(phoneToken).toBeTruthy();

    const code = await call('/device/code', { body: { client_id: 'juno-watch' } });
    expect(code.status).toBe(200);
    const deviceCode = code.json['device_code'] as string;
    const userCode = code.json['user_code'] as string;
    expect(userCode).toHaveLength(8);

    const pending = await call('/device/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: 'juno-watch' },
    });
    expect(pending.status).toBe(400);
    expect(pending.json['error']).toBe('authorization_pending');

    // The phone first claims the code (this is also the screen that asks "allow this watch?"), then approves it.
    const claim = await call(`/device?user_code=${userCode}`, { token: phoneToken });
    expect(claim.status).toBe(200);
    expect(claim.json['status']).toBe('pending');
    const approve = await call('/device/approve', { body: { userCode }, token: phoneToken });
    expect(approve.status).toBe(200);
    expect(approve.json).toMatchObject({ success: true });

    vi.setSystemTime(Date.now() + 6_000);
    const token = await call('/device/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: 'juno-watch' },
    });
    expect(token.status).toBe(200);
    const watchToken = token.json['access_token'] as string;

    const watchSession = await call('/get-session', { token: watchToken });
    const phoneSession = await call('/get-session', { token: phoneToken });
    expect(watchSession.json['user'].id).toBe(phoneSession.json['user'].id);
  }, 60_000);

  it('refuses clients that are not the watch', async () => {
    const { call } = await setup();
    const res = await call('/device/code', { body: { client_id: 'something-else' } });
    expect(res.status).toBe(400);
  }, 60_000);

  it('does not let an anonymous caller approve a code', async () => {
    const { call } = await setup();
    const code = await call('/device/code', { body: { client_id: 'juno-watch' } });
    const res = await call('/device/approve', { body: { userCode: code.json['user_code'] } });
    expect(res.status).toBe(401);
  }, 60_000);

  it('a denied code never yields a session', async () => {
    const { call } = await setup();
    const phone = await call('/sign-up/email', { body: { email: 'owner@example.com', password: 'correct-horse-battery', name: 'Owner' } });
    const code = await call('/device/code', { body: { client_id: 'juno-watch' } });
    await call(`/device?user_code=${code.json['user_code']}`, { token: phone.json['token'] });
    await call('/device/deny', { body: { userCode: code.json['user_code'] }, token: phone.json['token'] });
    vi.setSystemTime(Date.now() + 6_000);
    const token = await call('/device/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.json['device_code'], client_id: 'juno-watch' },
    });
    expect(token.status).toBe(400);
    expect(token.json['error']).toBe('access_denied');
  }, 60_000);
});
