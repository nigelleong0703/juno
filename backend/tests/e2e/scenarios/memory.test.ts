import { aguiInput } from '../../agui-input.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAccount, listRuns, scriptModel, runNow as runTimerNow, stackUrls, toolCall, transcriptMessages, waitForToolActivity, waitForTranscript, type Account } from '../harness/client';

/**
 * Memory as items (BACKEND §5.4, §9.5): an agent notes something with memory_note, which writes an active item the views show marked with
 * its writer. Then the chat digest, run once the chat has gone quiet, turns the user's own messages (the agent's notes and replies are
 * context, never evidence) into verified claims and tagged lines in MEMORY.md; the next conversation carries the memory section (the items
 * the run may see), memory_search and memory_explain find the items and their proof, and forgetting removes them for good. Another account sees
 * none of it.
 */

/** Runs the chat digest of one conversation now, as the quiet window would (the e2e stack's window is short; `runNow` skips the wait). */
async function runDigest(account: Account, agentId: string, conversationId: string): Promise<{ outcome: string }> {
  return runTimerNow('ChatDigest', conversationId, account.userId, { ownerId: account.userId, agentId, conversationId });
}

async function itemIdOf(account: Account, conversationId: string, type: 'user_message' | 'agent_message', containing: string): Promise<string> {
  const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=100`);
  const found = (items.body.items as Array<{ id: string; type: string; text?: string; markdown?: string }>).find((item) => item.type === type && (item.text ?? item.markdown ?? '').includes(containing));
  if (found === undefined) throw new Error(`no ${type} containing ${containing}`);
  return found.id;
}

/** A message sent while the previous run is still finishing is folded into it, which would shift the scripted turns. */
async function idle(account: Account, conversationId: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const runs = await listRuns(account, conversationId);
    if (runs.length > 0 && runs.every((run) => ['completed', 'failed', 'stopped'].includes(run.status))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('runs did not finish');
}

/** Past the e2e quiet window (3 s): the automatic digest has run by then, so a scripted answer is not taken by it. */
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 4_000));

const homeFile = async (account: Account, path: string): Promise<string | undefined> =>
  ((await account.api('GET', `/v1/home?path=${encodeURIComponent(path)}`)).body.files as Array<{ path: string; content: string }>).find((file) => file.path === path)?.content;

describe('agent memory', () => {
  it('turns a memory note and the user\'s words into verified, explainable, forgettable memory', async () => {
    const alice = await createAccount('memory-alice');
    const bob = await createAccount('memory-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Rememberer' });
    expect(agent.status).toBe(201);
    const agentId: string = agent.body.id;
    const today = new Date().toISOString().slice(0, 10);

    // 1. The agent notes it with memory_note: an active item, shown in the views marked with its writer (and read back as an item, below).
    const created = await alice.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
    const conversationId: string = created.body.id;
    const sessionKey = `${agentId}:${conversationId}`;
    scriptModel(sessionKey, [
      { text: 'Let me note that down.', toolCalls: [toolCall('call-log', 'memory_note', { about: 'user', kind: 'circumstance', text: 'Alice is allergic to peanuts' })] },
      { text: 'noted' },
      { text: 'second' },
    ]);
    expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'I live in Leiden and I work nights. Please remember I am allergic to peanuts.' }))).status).toBe(202);
    const first = await waitForToolActivity(sessionKey, (a) => a.results.length >= 1);
    expect(first.results[0]).toMatchObject({ toolName: 'memory_note', isError: false });
    const firstContext = (await waitForTranscript(sessionKey, (messages) => messages.some((text) => text.includes('noted')))).join('\n');
    expect(firstContext).toContain('memory_note');
    // Noting is quiet: the text that came with the note is not posted as an opening line.
    await idle(alice, conversationId);
    const firstItems = (await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<{ type: string; markdown?: string }>;
    expect(firstItems.filter((item) => item.type === 'agent_message').map((item) => item.markdown)).toEqual(['noted']);

    await idle(alice, conversationId);
    expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'thanks' }))).status).toBe(202);
    // The second run starts with a sync that reads the note back; wait for its reply, not for a word in the context.
    for (let i = 0; i < 60 && !(await transcriptMessages(sessionKey)).some((message) => message.role === 'assistant' && message.text.includes('"second"')); i += 1) await new Promise((r) => setTimeout(r, 500));
    await idle(alice, conversationId);
    // The note is an item: its line is in the bank view, worded in the third person and marked with its writer (agent name and id).
    const bank = (await homeFile(alice, 'memory/bank/circumstances.md')) ?? '';
    expect(bank).toMatch(new RegExp(`^- Alice is allergic to peanuts \\(noted by Rememberer, ${agentId}\\) \\[mem:[\\w-]+\\]$`, 'm'));

    // 2. The chat digest: claims need the user's exact words in one of their own messages; the others (a quote that is not there, and a
    // quote from the agent's own reply, which is context and never evidence) are thrown away.
    const itemId = await userItemId(alice, conversationId, 'I live in Leiden');
    const replyId = await itemIdOf(alice, conversationId, 'agent_message', 'noted');
    await quiet();
    scriptModel(`digest:${conversationId}`, [{
      text: JSON.stringify({ memory: [
        { text: 'Lives in Leiden.', evidence: [{ itemId, quote: 'I live in Leiden' }], confidence: 0.9, target: 'memory' },
        { text: 'Allergic to peanuts.', evidence: [{ itemId, quote: 'I am allergic to peanuts' }], confidence: 0.95, target: 'memory' },
        { text: 'Is allergic to nuts in general.', evidence: [{ itemId: replyId, quote: 'noted' }], confidence: 0.95, target: 'memory' },
        { text: 'Works days.', evidence: [{ itemId, quote: 'I work days' }], confidence: 0.9, target: 'circumstances' },
      ] }),
    }]);
    expect((await runDigest(alice, agentId, conversationId)).outcome).toBe('done');

    const sheet = (await homeFile(alice, 'MEMORY.md')) ?? '';
    expect(sheet).toMatch(/- Lives in Leiden\. \[claim:clm_\w+\]/);
    expect(sheet).toMatch(/- Allergic to peanuts\. \[claim:clm_\w+\]/);
    expect(sheet).not.toContain('nuts in general');
    // The bank keeps only what was noted: the digest's "Works days" claim was refused, so it never lands there.
    expect((await homeFile(alice, 'memory/bank/circumstances.md')) ?? '').not.toContain('Works days');
    const receipt = (await homeFile(alice, `self_improvement/${today}-digest.md`)) ?? '';
    expect(receipt).toContain('a single sighting is activity, not a circumstance: Works days.');
    expect(receipt).toContain('the quote is not in its source: Is allergic to nuts in general.');
    const claims = (await alice.api('GET', '/v1/memory/claims?status=active')).body.claims as Array<{ id: string; text: string; evidence: Array<{ itemId: string; quote: string }> }>;
    expect(claims.map((claim) => claim.text).sort()).toEqual(['Allergic to peanuts.', 'Lives in Leiden.']);
    expect(claims.find((claim) => claim.text === 'Lives in Leiden.')?.evidence).toEqual([{ itemId, quote: 'I live in Leiden' }]);
    expect(claims.find((claim) => claim.text === 'Allergic to peanuts.')?.evidence).toEqual([{ itemId, quote: 'I am allergic to peanuts' }]);
    const runs = (await alice.api('GET', '/v1/runs?limit=100')).body.items as Array<{ kind: string; triggerLabel?: string }>;
    expect(runs.some((run) => run.kind === 'background' && run.triggerLabel === 'Chat digest')).toBe(true);

    // 3. The next conversation carries the memory section (built from the items), and the agent can search and explain them.
    const leidenClaimId = (claims.find((claim) => claim.text === 'Lives in Leiden.') ?? { id: '' }).id;
    scriptModel(sessionKey, [
      { toolCalls: [toolCall('call-log', 'memory_note', { about: 'user', kind: 'circumstance', text: 'Alice is allergic to peanuts' })] },
      { text: 'noted' },
      { text: 'second' },
      { toolCalls: [
        toolCall('call-search', 'memory_search', { query: 'peanuts' }),
        toolCall('call-explain', 'memory_explain', { tag: `[claim:${leidenClaimId}]` }),
      ] },
      { text: 'third' },
    ]);
    expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'what do you know about me?' }))).status).toBe(202);
    const activity = await waitForToolActivity(sessionKey, (a) => a.results.some((result) => result.toolName === 'memory_explain'));
    const context = (await transcriptMessages(sessionKey)).map((message) => message.text).join('\n');
    expect(context).toContain('## Memory');
    expect(context).toMatch(/- Lives in Leiden\. \(said by [^\n]+ in app\)/);
    // Today's note is an item too, listed with who said it (the agent's own note) and where.
    expect(context).toMatch(/- Alice is allergic to peanuts \(said by [^\n]+ in app\)/);
    expect(activity.results.find((result) => result.toolName === 'memory_search')?.text).toContain('peanuts');
    expect(activity.results.find((result) => result.toolName === 'memory_explain')?.text).toContain('"I live in Leiden"');
    const offered = readFileSync(stackUrls().scriptFile + '.tools.jsonl', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { sessionKey: string; tools: string[] });
    const tools = offered.filter((call) => call.sessionKey === sessionKey).at(-1)?.tools ?? [];
    // The memory tools are not in the model's short tool list: it finds them with tool_search and runs them through tool_call.
    expect(tools).toEqual(expect.arrayContaining(['tool_search', 'tool_call']));
    expect(tools.some((name) => name.startsWith('memory_'))).toBe(false);

    // 4. The app's search reads the same items, and reports the view each one is shown in.
    const found = (await alice.api('GET', '/v1/memory/search?q=peanuts')).body.hits as Array<{ id: string; text: string; file: string }>;
    expect(found.map((hit) => hit.file)).toEqual(expect.arrayContaining(['memory', 'bank:circumstances']));

    // 5. Another account sees none of it and cannot forget Alice's claims.
    expect((await bob.api('GET', '/v1/memory/claims')).body.claims).toEqual([]);
    expect((await bob.api('GET', '/v1/memory/search?q=peanuts')).body.hits).toEqual([]);
    expect((await bob.api('POST', '/v1/memory/forget', { claimIds: claims.map((claim) => claim.id) })).body).toEqual({ retracted: 0, removedLines: 0 });
    expect(await homeFile(alice, 'MEMORY.md')).toContain('Lives in Leiden.');

    // 6. Forgetting retracts the claim and removes its line; the old memory routes are gone.
    const leiden = claims.find((claim) => claim.text === 'Lives in Leiden.');
    const forgotten = await alice.api('POST', '/v1/memory/forget', { claimIds: [leiden?.id] });
    expect(forgotten.body).toEqual({ retracted: 1, removedLines: 1 });
    const after = (await homeFile(alice, 'MEMORY.md')) ?? '';
    expect(after).not.toContain('Leiden');
    expect(after).toContain('Allergic to peanuts.');
    expect(((await alice.api('GET', '/v1/memory/claims?status=retracted')).body.claims as Array<{ text: string }>).map((claim) => claim.text)).toEqual(['Lives in Leiden.']);
    expect((await alice.api('GET', '/v1/memories')).status).toBe(404);
  });
});

async function userItemId(account: Account, conversationId: string, containing: string): Promise<string> {
  return itemIdOf(account, conversationId, 'user_message', containing);
}
