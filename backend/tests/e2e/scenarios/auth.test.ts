import { describe, expect, it } from 'vitest';
import { createAccount, getSession, request, signIn, signOut, signUp, uniqueEmail } from '../harness/client';

describe('account auth', () => {
  it('signs up, signs in, guards /v1 and signs out', async () => {
    const email = uniqueEmail('auth');
    const password = 'e2e-password-1234';

    // /v1 is closed to anonymous callers.
    expect((await request('GET', '/v1/agents')).status).toBe(401);

    // Sign up returns a session cookie that opens /v1.
    const up = await signUp(email, password, 'Auth User');
    expect(up.status).toBe(200);
    expect(up.userId).toBeTruthy();
    expect(up.cookie).not.toBe('');
    expect((await request('GET', '/v1/agents', undefined, up.cookie)).status).toBe(200);

    // A wrong password is refused; the right one signs in as the same user.
    expect((await signIn(email, 'wrong-password-1234')).status).toBe(401);
    const inn = await signIn(email, password);
    expect(inn.status).toBe(200);
    expect(inn.userId).toBe(up.userId);
    expect(inn.cookie).not.toBe('');
    expect((await getSession(inn.cookie)).body?.user?.id).toBe(up.userId);

    // Sign out revokes that session.
    expect((await signOut(inn.cookie)).status).toBe(200);
    expect((await request('GET', '/v1/agents', undefined, inn.cookie)).status).toBe(401);
  });

  it('gives every account its own data', async () => {
    const alice = await createAccount('alice');
    const bob = await createAccount('bob');
    const created = await alice.api('POST', '/v1/agents', { name: 'Private Agent' });
    expect(created.status).toBe(201);

    const bobSees = await bob.api('GET', '/v1/agents');
    expect(bobSees.status).toBe(200);
    expect(bobSees.body.items.map((a: { id: string }) => a.id)).not.toContain(created.body.id);
  });
});
