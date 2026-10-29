import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { createAccount, listenEvents, scriptedChat, toolCall, type EventListener, type SseEvent } from '../harness/client';

/**
 * Two clients of one account on the same conversation (AGUI-INTEGRATION): phone A stays on its live stream, tablet B
 * connects late (a full replay plus the synthesized snapshot) and later reconnects from its cursor. They must converge:
 * the same rows, no duplicated message, and an approval decided through the standard resume entry on B clears on A.
 */
const rowIds = (events: EventListener): number[] => events.events.filter((e) => e.id > 0).map((e) => e.id);
const authoritativeReplies = (events: EventListener, text: string): string[] =>
  events.events
    .filter((e) => e.data.type === 'TEXT_MESSAGE_CONTENT' && !String(e.data.messageId).startsWith('preview_') && String(e.data.delta).includes(text))
    .map((e) => String(e.data.messageId));
const snapshotOf = (events: EventListener, conversationId: string): SseEvent | undefined =>
  events.events.find((e) => e.id === 0 && e.data.type === 'MESSAGES_SNAPSHOT' && e.data.metadata?.juno?.conversationId === conversationId);
const snapshotMessageIds = (snapshot: SseEvent | undefined): string[] => ((snapshot?.data.messages ?? []) as Array<{ id: string }>).map((m) => m.id);

describe('two clients on one conversation', () => {
  it('converge without duplicated messages, and an approval decided on one client clears on the other', async () => {
    const account = await createAccount('two-clients');
    const phone = await listenEvents(account.cookie, 'ios');
    const sockets: EventListener[] = [phone];
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Careful' });
      expect(agent.status).toBe(201);
      const rule = await account.api('POST', '/v1/rules', { description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true });
      expect(rule.status).toBeLessThan(300);
      const done = `CONVERGED-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: done },
      ], 'who else is on the team?');

      const created = await phone.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;
      const runId: string = created.data.request.runId;
      await phone.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type === 'interrupt' && e.data.metadata.juno.run.id === runId, 30_000);

      // The tablet joins while the run waits on the card: full replay from the start of the log, then the snapshot.
      const tablet = await listenEvents(account.cookie, 'web');
      sockets.push(tablet);
      await tablet.waitFor((e) => e.data.type === 'request.created' && e.data.request.id === requestId, 30_000);
      await tablet.waitFor((e) => e.id === 0 && e.data.type === 'MESSAGES_SNAPSHOT' && e.data.metadata?.juno?.conversationId === conversationId, 30_000);
      expect(new Set(rowIds(tablet)).size).toBe(rowIds(tablet).length);
      const waiting = snapshotMessageIds(snapshotOf(tablet, conversationId));
      expect(new Set(waiting).size).toBe(waiting.length);
      const userTurns = ((snapshotOf(tablet, conversationId)?.data.messages ?? []) as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'user');
      expect(userTurns.map((m) => m.content)).toEqual(['who else is on the team?']);

      // The tablet approves through the standard resume entry; the phone's card must resolve too.
      const resume = await account.api('POST', `/v1/conversations/${conversationId}/runs`, {
        ...aguiInput(`/v1/conversations/${conversationId}/runs`, { text: '' }),
        runId,
        messages: [],
        resume: [{ interruptId: requestId, status: 'resolved', payload: { action: 'approve' } }],
      });
      expect(resume.status).toBe(202);
      for (const client of [phone, tablet]) {
        const resolved = await client.waitFor((e) => e.data.type === 'request.resolved' && e.data.request.id === requestId, 30_000);
        expect(resolved.data.request.status).toBe('approved');
        await client.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(done), 45_000);
        await client.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type === 'success' && e.data.metadata.juno.run.id === runId, 30_000);
      }
      expect((await account.api('GET', `/v1/requests/${requestId}`)).body.status).toBe('approved');

      // Same replies, same rows, nothing twice: one live stream and one replay-plus-live stream agree.
      const itemReplies = (client: EventListener): string[] =>
        client.events.filter((e) => e.data.type === 'item.added' && String(e.data.item?.markdown).includes(done)).map((e) => e.data.item.id as string);
      expect(itemReplies(phone)).toHaveLength(1);
      expect(itemReplies(tablet)).toEqual(itemReplies(phone));
      expect(authoritativeReplies(phone, done)).toEqual(itemReplies(phone));
      expect(authoritativeReplies(tablet, done)).toEqual(itemReplies(phone));
      for (const client of [phone, tablet]) expect(new Set(rowIds(client)).size).toBe(rowIds(client).length);
      expect(phone.events.filter((e) => e.data.type === 'request.resolved' && e.data.request.id === requestId)).toHaveLength(1);
      expect(tablet.events.filter((e) => e.data.type === 'request.resolved' && e.data.request.id === requestId)).toHaveLength(1);

      // The tablet drops and reconnects from its cursor: it gets only newer rows plus a snapshot that holds the reply once.
      const cursor = Math.max(...rowIds(tablet));
      tablet.close();
      const again = await listenEvents(account.cookie, 'web', cursor);
      sockets.push(again);
      await again.waitFor((e) => e.id === 0 && e.data.type === 'MESSAGES_SNAPSHOT' && e.data.metadata?.juno?.conversationId === conversationId, 30_000);
      const restored = snapshotMessageIds(snapshotOf(again, conversationId));
      const replyId = itemReplies(phone)[0] as string;
      expect(restored.filter((id) => id === replyId)).toHaveLength(1);
      expect(new Set(restored).size).toBe(restored.length);
      expect(rowIds(again).every((id) => id > cursor)).toBe(true);
      expect(again.events.some((e) => e.data.type === 'item.added' && e.data.item?.id === replyId)).toBe(false);
    } finally {
      for (const client of sockets) client.close();
    }
  });
});
