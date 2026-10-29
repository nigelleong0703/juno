import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * The agent searches the web when it does not know something or the answer is recent: a song it cannot place,
 * today's news. Needs live search: run with E2E_SEARCH_PROVIDER=exa E2E_SEARCH_API_KEY=... (skipped without).
 */
const live = process.env['E2E_SEARCH_PROVIDER'] && process.env['E2E_SEARCH_API_KEY'] ? describe : describe.skip;

live('real model: web_search guidance', () => {
  async function ask(text: string) {
    const account = await createAccount('real-search');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
      const started = await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === started.data.metadata.juno.run.id, 200_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      return (await toolActivity(`${agent.body.id}:${conversationId}`)).calls.filter((call) => call.name === 'web_search');
    } finally {
      events.close();
    }
  }

  it('searches to identify a song', async () => {
    expect((await ask('who sings the song with the lyrics "and I say hey, what\'s going on"')).length).toBeGreaterThanOrEqual(1);
  });

  it('searches for recent news with a date or news category', async () => {
    const searches = await ask('what happened in the news today in Singapore');
    expect(searches.length).toBeGreaterThanOrEqual(1);
    const cutoff = Date.now() - 14 * 86_400_000;
    expect(searches.some((call) => call.arguments['category'] === 'news' || (typeof call.arguments['since'] === 'string' && Date.parse(call.arguments['since']) > cutoff))).toBe(true);
  });
});
