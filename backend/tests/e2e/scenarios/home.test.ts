import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, scriptModel, scriptedChat, toolCall, transcriptMessages, waitForToolActivity, waitForTranscript } from '../harness/client';

/**
 * The agent's home files (BACKEND §5): what the user writes in the app (create input, PUT /v1/home) is what the model
 * reads, an edit reaches the running conversation, the file tools keep the agent out of protected and foreign paths,
 * and another account can neither see nor write any of it.
 */
describe('agent home files', () => {
  it('puts the user-written files into the context and guards them from the agent and other accounts', async () => {
    const alice = await createAccount('home-alice');
    const bob = await createAccount('home-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Pirate', personality: 'Speaks like a pirate.', principles: 'Never uses emoji.' });
    expect(agent.status).toBe(201);
    const other = await alice.api('POST', '/v1/agents', { name: 'Other', personality: 'Secret persona of the other agent.' });
    expect(other.status).toBe(201);
    const agentId: string = agent.body.id;

    const user = await alice.api('PUT', '/v1/home/USER.md', { content: 'Alice is a nurse in Leiden.' });
    expect(user.status).toBe(200);

    const listed = await alice.api('GET', `/v1/home?path=agents/${agentId}/`);
    expect(listed.status).toBe(200);
    const files: Array<{ path: string; content: string }> = listed.body.files;
    expect(files.find((file) => file.path === `agents/${agentId}/IDENTITY.md`)?.content).toBe('Speaks like a pirate.');
    expect(files.find((file) => file.path === `agents/${agentId}/SOUL.md`)?.content).toBe('Never uses emoji.');

    const { sessionKey, conversationId } = await scriptedChat(alice, agentId, [
      { toolCalls: [toolCall('call-protected', 'files.write', { path: '/juno/MEMORY.md', content: 'hijacked' })] },
      { toolCalls: [toolCall('call-foreign', 'files.read', { path: `/juno/agents/${other.body.id}/IDENTITY.md` })] },
      { text: 'arr' },
    ], 'hello');

    const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 2);
    expect(activity.results[0]).toMatchObject({ toolName: 'files.write', isError: true });
    expect(activity.results[1]).toMatchObject({ toolName: 'files.read', isError: true });
    expect(activity.results[1]?.text).toContain('agent_directory');

    const first = (await transcriptMessages(sessionKey)).map((message) => message.text).join('\n');
    expect(first).toContain('Speaks like a pirate.');
    expect(first).toContain('Never uses emoji.');
    expect(first).toContain('Alice is a nurse in Leiden.');
    expect(first).not.toContain('Secret persona of the other agent.');

    // An edit in the app reaches the same conversation on its next run.
    const soul = files.find((file) => file.path === `agents/${agentId}/SOUL.md`) as { hash?: string } | undefined;
    const edited = await alice.api('PUT', `/v1/home/agents/${agentId}/SOUL.md`, { content: 'Answers in one short line.', expectedHash: soul?.hash });
    expect(edited.status).toBe(200);
    const stale = await alice.api('PUT', `/v1/home/agents/${agentId}/SOUL.md`, { content: 'late write', expectedHash: soul?.hash });
    expect(stale.status).toBe(409);
    scriptModel(sessionKey, [{ text: 'placeholder' }, { text: 'aye' }]);
    expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'again' }))).status).toBeLessThan(300);
    await waitForTranscript(sessionKey, (messages) => messages.some((text) => text.includes('Answers in one short line.')));

    // Another account sees none of it and cannot write it.
    const bobs = await bob.api('GET', '/v1/home?path=');
    expect(bobs.status).toBe(200);
    // Bob has only the files of his own default agent (made at sign-up), none of Alice's.
    expect(JSON.stringify(bobs.body.files)).not.toMatch(/Leiden|pirate|Answers in one short line/);
    expect(JSON.stringify(bobs.body.files)).not.toContain(agentId);
    expect([403, 404]).toContain((await bob.api('PUT', `/v1/home/agents/${agentId}/SOUL.md`, { content: 'hijacked' })).status);
  });
});
