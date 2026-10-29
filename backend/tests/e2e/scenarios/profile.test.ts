import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, scriptModel, toolCall, waitForToolActivity, waitForTranscript } from '../harness/client';

/**
 * Your details (BACKEND §8.7): one flat list of key/value entries. The agent saves them with profile_update (source agent, a
 * matching key updates in place, a secret is refused), the next turn's context lists them, and the user's PUT edits them
 * (new or changed entries become the user's, untouched ones keep their source).
 */
describe('profile entries', () => {
  it('lets the agent learn details, shows them to the next turn, and lets the user edit them', async () => {
    const account = await createAccount('profile-entries');
    const agentId: string = (await account.api('POST', '/v1/agents', { name: 'Filler' })).body.id;
    const conversationId: string = (await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] })).body.id;
    const sessionKey = `${agentId}:${conversationId}`;
    // Sign-up wrote the user's name as the first entry.
    expect((await account.api('GET', '/v1/profile')).body.entries).toMatchObject([{ key: 'Name', source: { by: 'user' } }]);
    scriptModel(sessionKey, [
      { toolCalls: [toolCall('a', 'profile_update', { set: [{ key: 'Work email', value: 'jane@acme.com' }, { key: 'Home address', value: '10 Anson Rd\n#12-01\nSingapore 079903\nSingapore' }] })] },
      { toolCalls: [toolCall('b', 'profile_update', { set: [{ key: 'Bank card number', value: '4242 4242 4242 4242' }] })] },
      { text: 'saved' },
    ]);
    expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'my work email is jane@acme.com and I live at 10 Anson Rd' }))).status).toBe(202);
    const first = await waitForToolActivity(sessionKey, (a) => a.results.length >= 2);
    expect(first.results.map((r) => r.isError)).toEqual([false, true]);

    const saved = (await account.api('GET', '/v1/profile')).body;
    expect(saved.entries.slice(1)).toMatchObject([
      { key: 'Work email', value: 'jane@acme.com', visibility: 'private', source: { by: 'agent', agentId, conversationId } },
      { key: 'Home address', value: '10 Anson Rd\n#12-01\nSingapore 079903\nSingapore', source: { by: 'agent' } },
    ]);
    const context = (await waitForTranscript(sessionKey, (messages) => messages.some((text) => text.includes('saved')))).join('\n');
    expect(context).toContain("## Your user's details");
    expect(context).toContain('- Work email: jane@acme.com');

    // The user edits: one entry changed, one added, one untouched.
    const [name, email, address] = saved.entries as Array<{ id: string; key: string; value: string; visibility: string }>;
    const put = await account.api('PUT', '/v1/profile', { entries: [
      { id: name!.id, key: name!.key, value: name!.value, visibility: name!.visibility },
      { id: email!.id, key: 'Work email', value: 'jane@acme.org', visibility: 'shared' },
      { id: address!.id, key: address!.key, value: address!.value, visibility: address!.visibility },
      { id: 'new-1', key: 'KrisFlyer number', value: '8812345', visibility: 'private' },
    ] });
    expect(put.status).toBe(200);
    expect(put.body.entries.slice(1)).toMatchObject([
      { key: 'Work email', visibility: 'shared', source: { by: 'user' } },
      { key: 'Home address', source: { by: 'agent', agentId } },
      { key: 'KrisFlyer number', source: { by: 'user' } },
    ]);
    expect((await account.api('PUT', '/v1/profile', { entries: [{ id: 'x', key: 'Password', value: 'hunter2' }] })).status).toBe(400);
    expect((await account.api('PUT', '/v1/profile', { entries: [{ id: 'x', key: 'Card', value: '4242424242424242' }] })).status).toBe(400);
  });
});
