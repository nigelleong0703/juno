import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, request, stackUrls } from '../harness/client';

/**
 * Per-routine webhook secrets: the hook needs no login session but always needs the routine's secret
 * (header, bearer or ?key=). Unknown routine, wrong secret and a routine without a secret all answer the
 * same 401; the secret is only ever returned by the owner's rotate call and never by reads.
 */
describe('webhook secret', () => {
  it('opens the hook only with the routine secret and rotates it', async () => {
    const account = await createAccount('hook-secret');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Hooked' });
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const routine = await account.api('POST', '/v1/routines', {
        name: 'Inbound', agentId: agent.body.id, instructions: 'react', enabled: true,
        trigger: { kind: 'webhook', url: 'pending', secretMasked: '' },
        delivery: { channel: 'chat', target: chat.body.id }, notify: { mode: 'never' },
      });
      expect(routine.status).toBe(201);
      const hookPath = `/v1/hooks/${routine.body.id}`;
      const payload = { type: 'ping' };

      // No secret stored yet: every call is refused, with or without a login session or a presented secret.
      const unknown = await request('POST', '/v1/hooks/rtn-nope', payload, undefined, { 'X-Hook-Secret': 'x' });
      expect(unknown.status).toBe(401);
      expect((await request('POST', hookPath, payload, undefined, { 'X-Hook-Secret': 'x' })).body).toEqual(unknown.body);
      expect((await request('POST', hookPath, payload, account.cookie)).status).toBe(401);
      expect((await request('POST', hookPath, payload, account.cookie, { 'X-Hook-Secret': 'x' })).status).toBe(401);

      const issued = await account.api('POST', `/v1/routines/${routine.body.id}/webhook`);
      expect(issued.status).toBe(200);
      expect(issued.body.url).toBe(stackUrls().apiUrl + hookPath);
      expect(issued.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Reads never carry the secret, only its mask.
      const read = await account.api('GET', `/v1/routines/${routine.body.id}`);
      expect(JSON.stringify(read.body)).not.toContain(issued.body.secret);
      expect(read.body.trigger).toEqual({ kind: 'webhook', url: issued.body.url, secretMasked: expect.stringContaining(issued.body.secret.slice(-4)) });

      const wrong = await request('POST', hookPath, payload, undefined, { 'X-Hook-Secret': 'wrong' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect((await request('POST', hookPath, payload)).status).toBe(401);
      expect((await request('POST', `${hookPath}?key=wrong`, payload)).status).toBe(401);
      // ?key= is the first accepted call, and it really starts the routine's run in its chat.
      const viaKey = await request('POST', `${hookPath}?key=${issued.body.secret}`, payload);
      expect(viaKey.status).toBe(202);
      const run = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === chat.body.id, 30_000);
      expect(run.data.metadata.juno.run.status).toBe('completed');
      const bearer = await request('POST', hookPath, payload, undefined, { Authorization: `Bearer ${issued.body.secret}` });
      expect(bearer.status).toBe(202);

      // Rotating replaces the secret: the old one stops working at once.
      const rotated = await account.api('POST', `/v1/routines/${routine.body.id}/webhook`);
      expect(rotated.body.secret).not.toBe(issued.body.secret);
      expect((await request('POST', `${hookPath}?key=${issued.body.secret}`, payload)).status).toBe(401);
      expect((await request('POST', `${hookPath}?key=${rotated.body.secret}`, payload)).status).toBe(202);

      // Only the owner can issue a secret, and only for a webhook routine.
      const other = await createAccount('hook-other');
      expect((await other.api('POST', `/v1/routines/${routine.body.id}/webhook`)).status).toBe(404);
      const scheduled = await account.api('POST', '/v1/routines', {
        name: 'Nightly', agentId: agent.body.id, instructions: 'x', enabled: false,
        trigger: { kind: 'schedule', cron: '0 3 * * *', human: 'nightly', tz: 'UTC' },
        delivery: { channel: 'chat', target: chat.body.id }, notify: { mode: 'never' },
      });
      expect((await account.api('POST', `/v1/routines/${scheduled.body.id}/webhook`)).status).toBe(400);
    } finally {
      events.close();
    }
  });
});
