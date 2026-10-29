import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, queryStack, request, scriptedChat, signIn, transcriptTexts } from '../harness/client';

/**
 * Deleting an account (M-PROD-2, BACKEND §5.2c): `DELETE /v1/account` signs the user out everywhere at once, the rest is a job that
 * removes every row, upload and event of the account, emits the delete events other open devices need, and leaves another account
 * exactly as it was.
 */
describe('account deletion', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const count = async (table: string, owner: string) => Number((await queryStack(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`, [owner]))[0]?.['n'] ?? 0);

  it('removes the account and all its data, tells open devices, and leaves other accounts alone', async () => {
    const leaving = await createAccount('acct-del');
    const staying = await createAccount('acct-del-other');
    const events = await listenEvents(leaving.cookie);
    try {
      const agent = await leaving.api('POST', '/v1/agents', { name: 'Goodbye' });
      expect(agent.status).toBe(201);
      const { conversationId, sessionKey } = await scriptedChat(leaving, agent.body.id, [{ text: `DONE-${randomUUID().slice(0, 8)}` }], 'hello');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);
      expect((await transcriptTexts(sessionKey)).length).toBeGreaterThan(0);
      const upload = await leaving.api('POST', '/v1/uploads', { name: 'mine.txt', mimeType: 'text/plain', contentBase64: b64(`ONLY-MINE-${randomUUID()}`) });
      expect(upload.status).toBe(201);
      const keeper = await staying.api('POST', '/v1/agents', { name: 'Keeper' });
      expect(keeper.status).toBe(201);
      const keeperUpload = await staying.api('POST', '/v1/uploads', { name: 'kept.txt', mimeType: 'text/plain', contentBase64: b64('KEEP-ME') });
      const stayingRows = { agents: await count('agents', staying.userId), library: await count('library', staying.userId) };

      // A stray call without the confirmation deletes nothing.
      expect((await leaving.api('DELETE', '/v1/account', {})).status).toBe(400);
      expect((await leaving.api('GET', `/v1/agents/${agent.body.id}`)).status).toBe(200);

      // Someone else's session can only ever delete its own account, whatever the body says.
      const gone = await leaving.api('DELETE', '/v1/account', { confirm: true, ownerId: staying.userId });
      expect([200, 202]).toContain(gone.status);

      // Signed out everywhere at once, and the password no longer works.
      expect((await request('GET', '/v1/agents', undefined, leaving.cookie)).status).toBe(401);
      expect((await signIn(leaving.email, leaving.password)).status).toBe(401);

      // Open devices are told to drop the agent and the chat.
      await events.waitFor((e) => e.data.type === 'agent.deleted' && e.data.agentId === agent.body.id, 60_000);
      await events.waitFor((e) => e.data.type === 'conversation.deleted' && e.data.conversationId === conversationId, 60_000);

      // The job finishes: every row of the account and the sign-in rows are gone, the marker last.
      const deadline = Date.now() + 60_000;
      while (Number((await queryStack('SELECT COUNT(*) AS n FROM account_deletions WHERE owner_id = ?', [leaving.userId]))[0]?.['n']) > 0) {
        if (Date.now() > deadline) throw new Error('the account deletion did not finish');
        await new Promise((r) => setTimeout(r, 250));
      }
      for (const table of ['agents', 'conversations', 'items', 'runs', 'library', 'transcripts', 'settings', 'computers', 'screens']) expect(await count(table, leaving.userId)).toBe(0);
      expect(await queryStack('SELECT id FROM auth_user WHERE id = ?', [leaving.userId])).toHaveLength(0);
      expect(await transcriptTexts(sessionKey)).toHaveLength(0);

      // The other account is exactly as it was.
      expect(await count('agents', staying.userId)).toBe(stayingRows.agents);
      expect(await count('library', staying.userId)).toBe(stayingRows.library);
      expect((await staying.api('GET', `/v1/library/${keeperUpload.body.id}`)).status).toBe(200);
      expect((await staying.api('GET', `/v1/agents/${keeper.body.id}`)).status).toBe(200);
      expect((await signIn(staying.email, staying.password)).status).toBe(200);
    } finally {
      events.close();
    }
  });
});
