import { describe, expect, it } from 'vitest';

import { AGUI_PROTOCOL_VERSION } from '../../contracts.js';
import { createHttpClient } from '../client.js';

const userItem = {
  id: 'itm-user-1',
  conversationId: 'conv-1',
  at: '2026-10-29T00:00:00.000Z',
  type: 'user_message',
  authorId: 'usr-1',
  text: 'hello',
  attachments: [],
  mentions: [],
} as const;

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function clientWith(response: unknown) {
  const calls: Call[] = [];
  const client = createHttpClient({
    baseUrl: 'http://agui-test',
    getToken: () => 'token',
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Response.json(response, { status: 202 });
    },
  });
  return { client, calls };
}

describe('AG-UI conversation run entry', () => {
  it('sends a composer message as RunAgentInput to /runs and returns the stored item', async () => {
    const { client, calls } = clientWith({ item: userItem, runId: 'run-1' });
    const result = await client.conversations.send('conv-1', {
      text: 'hello',
      mentions: [{ kind: 'agent', id: 'agent-1', label: '@Juno' }],
      options: { background: true },
    });

    expect(result).toEqual({ item: userItem, runId: 'run-1' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/conversations/conv-1/runs');
    const body = calls[0]!.body;
    expect(body).toMatchObject({
      threadId: 'conv-1',
      protocolVersion: AGUI_PROTOCOL_VERSION,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      context: [],
      forwardedProps: {
        juno: {
          composer: {
            text: 'hello',
            mentions: [{ kind: 'agent', id: 'agent-1', label: '@Juno' }],
            options: { background: true },
          },
        },
      },
    });
    expect(body['runId']).toMatch(/^run-client-/);
  });

  it('reuses an explicit send identity while independent identical sends get fresh ids', async () => {
    const { client, calls } = clientWith({ item: userItem, runId: 'run-1' });
    const payload = { text: 'hello' };
    const identity = { messageId: 'message-retry', runId: 'run-retry' };
    await client.conversations.send('conv-1', payload, identity);
    await client.conversations.send('conv-1', payload, identity);
    expect(calls[0]?.body).toEqual(calls[1]?.body);
    await client.conversations.send('conv-1', payload);
    await client.conversations.send('conv-1', payload);
    expect(calls[2]?.body['runId']).not.toBe(calls[3]?.body['runId']);
    expect(calls[2]?.body['messages']).not.toEqual(calls[3]?.body['messages']);
  });

  it('preserves deny note and revise reason in a cancelled resume entry', async () => {
    const { client, calls } = clientWith({ runId: 'run-1' });
    const decision = { action: 'deny' as const, reason: 'revise' as const, note: 'Change the recipient' };
    await client.conversations.resumeRequest('conv-1', 'req-1', decision, 'run-1');
    expect(calls[0]?.body['resume']).toEqual([{ interruptId: 'req-1', status: 'cancelled', payload: decision }]);
  });

  it('resumes an interrupt with the typed decision and sends no synthetic user turn', async () => {
    const { client, calls } = clientWith({ runId: 'run-durable' });
    await client.conversations.resumeRequest(
      'conv-1',
      'req-1',
      { action: 'approve', scope: 'once' },
      'run-durable',
    );

    expect(new URL(calls[0]!.url).pathname).toBe('/v1/conversations/conv-1/runs');
    expect(calls[0]!.body).toMatchObject({
      threadId: 'conv-1',
      runId: 'run-durable',
      messages: [],
      resume: [
        {
          interruptId: 'req-1',
          status: 'resolved',
          payload: { action: 'approve', scope: 'once' },
        },
      ],
    });
  });

  it('sends every pending interrupt of a segment in one standard resume batch', async () => {
    const { client, calls } = clientWith({ runId: 'run-durable' });
    await client.conversations.resumeRequests(
      'conv-1',
      [
        { requestId: 'req-a', decision: { action: 'approve', scope: 'once' } },
        { requestId: 'req-b', decision: { action: 'answer', answers: { q: 'yes' } } },
        { requestId: 'req-c', decision: { action: 'deny' } },
      ],
      'run-durable',
    );
    expect(calls[0]!.body).toMatchObject({
      resume: [
        { interruptId: 'req-a', status: 'resolved', payload: { action: 'approve', scope: 'once' } },
        { interruptId: 'req-b', status: 'resolved', payload: { action: 'answer', answers: { q: 'yes' } } },
        { interruptId: 'req-c', status: 'cancelled' },
      ],
    });
  });

  it('maps denial to a cancelled interrupt', async () => {
    const { client, calls } = clientWith({ runId: 'run-durable' });
    await client.conversations.resumeRequest('conv-1', 'req-1', { action: 'deny', note: 'not this' });
    expect(calls[0]!.body).toMatchObject({
      resume: [{ interruptId: 'req-1', status: 'cancelled' }],
    });
  });

  it('accepts a standard run segment with no user item', async () => {
    const { client } = clientWith({ runId: 'run-next' });
    const result = await client.conversations.runAgent('conv-1', {
      threadId: 'conv-1',
      runId: 'run-client-next',
      protocolVersion: AGUI_PROTOCOL_VERSION,
      messages: [],
      tools: [],
      context: [],
      state: { ready: true },
      resume: [{ interruptId: 'req-1', status: 'cancelled' }],
    });
    expect(result).toEqual({ runId: 'run-next' });
  });

  it('maps stored attachment metadata to standard URL content parts', async () => {
    const { client, calls } = clientWith({ item: userItem, runId: 'run-files' });
    await client.conversations.send('conv-1', {
      text: 'see attached',
      attachments: [
        { id: 'att-image', name: 'chart.png', kind: 'image', mimeType: 'image/png', url: 'https://files.test/chart.png' },
        { id: 'att-doc', name: 'notes.pdf', kind: 'file', mimeType: 'application/pdf', url: 'https://files.test/notes.pdf' },
      ],
    });
    expect(calls[0]!.body['messages']).toEqual([
      {
        id: expect.stringMatching(/^msg-client-/),
        role: 'user',
        content: [
          { type: 'text', text: 'see attached' },
          { type: 'image', id: 'att-image', source: { type: 'url', value: 'https://files.test/chart.png', mimeType: 'image/png' } },
          { type: 'document', id: 'att-doc', source: { type: 'url', value: 'https://files.test/notes.pdf', mimeType: 'application/pdf' } },
        ],
      },
    ]);
  });

  it('preserves an uploaded attachment without a public URL', async () => {
    const { client, calls } = clientWith({ item: userItem, runId: 'run-upload' });
    const attachment = { id: 'upload-private', name: 'notes.txt', kind: 'file' as const, mimeType: 'text/plain', sizeBytes: 5 };
    await client.conversations.send('conv-1', { text: 'Read this', attachments: [attachment] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body['forwardedProps']).toMatchObject({ juno: { composer: { attachments: [attachment] } } });
  });

});
