import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, queryStack, scriptModel } from '../harness/client';

/**
 * A session pinned to an older harness version (BACKEND §11.2, "版本升级"): a deploy added a unit (`wake.automatic.nobody_waiting`) the pinned version
 * does not have. The session's next run must complete, with its own frozen text untouched, instead of failing with
 * "harness package is invalid ... referenced by code but missing".
 */
describe('harness pin upgrade', () => {
  it('a chat pinned to a version lacking a unit the code now needs still completes its run', async () => {
    const account = await createAccount('harness-pin');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Pinned' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id], firstMessage: { text: 'hello' } });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId);

      const frozen = async () => (await queryStack("SELECT doc->'message'->>'content' AS text, doc->'message'->'contextMeta'->>'harnessVersion' AS version FROM transcripts WHERE doc->>'sessionKey' = ? AND doc->'message'->>'role' = 'system'", [sessionKey]))[0];
      const before = await frozen();
      expect(String(before?.['version'])).toMatch(/^hv_/);

      // The older version: the active one minus the unit a later deploy added; the chat's frozen row is pinned to it.
      const oldId = 'hv_e2e' + randomUUID().replace(/-/g, '').slice(0, 6);
      await queryStack(
        "INSERT INTO harness_versions (id, parent_id, files, origin, status, note) SELECT ?, NULL, files - 'wake.automatic.nobody_waiting', 'seed', 'retired', 'e2e: an older version' FROM harness_versions WHERE status = 'active'",
        [oldId],
      );
      const missing = await queryStack("SELECT jsonb_exists(files, 'wake.automatic.nobody_waiting') AS has FROM harness_versions WHERE id = ?", [oldId]);
      expect(missing[0]?.['has']).toBe(false);
      await queryStack("UPDATE transcripts SET doc = jsonb_set(doc, '{message,contextMeta,harnessVersion}', to_jsonb(?::text)) WHERE doc->>'sessionKey' = ? AND doc->'message'->>'role' = 'system'", [oldId, sessionKey]);
      expect((await frozen())?.['version']).toBe(oldId);

      const reply = `PINNED-REPLY-${randomUUID().slice(0, 8)}`;
      scriptModel(sessionKey, [{ text: 'filler' }, { text: reply }]);
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'say the magic word' }));
      expect(sent.status).toBe(202);
      const scripted = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.markdown?.includes(reply), 45_000);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === scripted.data.item.runId);
      expect(finished.data.metadata.juno.run.status).toBe('completed');

      // The session keeps its pin and its frozen text (nothing was rewritten by the upgrade).
      const after = await frozen();
      expect(after?.['version']).toBe(oldId);
      expect(after?.['text']).toBe(before?.['text']);
    } finally {
      events.close();
    }
  });
});
