import { describe, expect, it } from 'vitest';
import { listenEvents, scriptedChat, toolActivity, toolCall } from '../harness/client';
import { setupConnector, stubConnector, type StubTool } from '../harness/mcp-fixture';

/**
 * BACKEND §3.3d.4 (live incident 2026-10-31): a read the connected app refuses, or whose arguments do not fit its schema, is a failed call the
 * model reads and fixes, never an "uncertain action" request for the person.
 */
const weatherSchema = {
  type: 'object',
  properties: {
    location: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
    date: { type: 'object', properties: { day: { type: 'integer' }, month: { type: 'integer' }, year: { type: 'integer' } }, required: ['day', 'month', 'year'] },
  },
  required: ['location', 'date'],
};
const tools: StubTool[] = [
  { name: 'lookup_weather', description: 'Weather for a place and day.', inputSchema: weatherSchema, annotations: { readOnlyHint: true }, answer: () => ({ result: { content: [{ type: 'text', text: 'Sunny, 31C' }] } }) },
  // No annotation: a change as far as the harness knows. The server refuses every call with HTTP 400 and says why.
  { name: 'save_note', description: 'Save a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, answer: () => ({ status: 400, body: '{"error":"note is too long"}' }) },
];

describe('a connected app\'s tool that is refused or called with the wrong shape', () => {
  it('stringified object arguments get an error naming the field without reaching the server; objects then work; no request card', async () => {
    const connector = await stubConnector(tools);
    const { account, agentId } = await setupConnector('mcp-refusal-shape', connector);
    const events = await listenEvents(account.cookie);
    try {
      const good = { location: { address: 'Singapore' }, date: { day: 6, month: 11, year: 2026 } };
      const text = 'What is the weather in Singapore on 6 November?';
      const { conversationId, sessionKey } = await scriptedChat(account, agentId, [
        { matchLastText: text, step: 0, toolCalls: [toolCall('w1', 'linear_lookup_weather', { location: JSON.stringify(good.location), date: JSON.stringify(good.date) })] },
        { matchLastText: text, step: 1, toolCalls: [toolCall('w2', 'linear_lookup_weather', good)] },
        { matchLastText: text, step: 2, text: 'Sunny and 31C.' },
      ], text);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      expect(connector.calls).toEqual([{ name: 'lookup_weather', args: good }]);
      const results = (await toolActivity(sessionKey)).results.filter((result) => result.toolName === 'linear_lookup_weather');
      expect(results).toHaveLength(2);
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.text).toContain('date: received a string of JSON text');
      expect(results[1]?.isError).toBe(false);
      expect((await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending`)).body.items ?? []).toEqual([]);
    } finally {
      events.close();
      await connector.close();
    }
  });

  it('an HTTP 400 from the server comes back as an ordinary tool error with its message: no request card, the run finishes', async () => {
    const connector = await stubConnector(tools);
    const { account, agentId } = await setupConnector('mcp-refusal-400', connector);
    const events = await listenEvents(account.cookie);
    try {
      const text = 'Save a note for me.';
      const { conversationId, sessionKey } = await scriptedChat(account, agentId, [
        { matchLastText: text, step: 0, toolCalls: [toolCall('n1', 'linear_save_note', { text: 'a very long note' })] },
        { matchLastText: text, step: 1, text: 'The note was too long, so I did not save it.' },
      ], text);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const [result] = (await toolActivity(sessionKey)).results.filter((entry) => entry.toolName === 'linear_save_note');
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain('note is too long');
      expect((await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending`)).body.items ?? []).toEqual([]);
    } finally {
      events.close();
      await connector.close();
    }
  });
});
