/**
 * The Responses WebSocket transport against a fake socket server, driven through pi-ai's real
 * Responses stream: events map unchanged, the delta is sent only for an exact continuation, and every
 * socket fault ends on the plain HTTP path with the full input.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { normalizeContext, type AssistantMessage, type Message, type ToolResultMessage } from '@earendil-works/pi-ai';
import { responsesModelFor } from '../provider-wire-compat.js';
import { createResponsesWsTransport, decideDelta, defaultEndpoint, type ResponsesWsTransport } from '../ws-responses.js';

type Frame = Record<string, unknown>;
interface Fake {
  url: string;
  frames: Frame[];
  connections: number;
  sockets: ServerSocket[];
  onFrame: (frame: Frame, socket: ServerSocket, index: number) => void;
  close(): Promise<void>;
}

const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 64 }, output_tokens_details: { reasoning_tokens: 0 } };

function sendEvents(socket: ServerSocket, events: Frame[]): void {
  for (const event of events) socket.send(JSON.stringify(event));
}

/** A tool-calling turn: reasoning item then a function call. */
function toolTurn(id: string): Frame[] {
  const reasoning = { type: 'reasoning', id: 'rs_' + id, summary: [], encrypted_content: 'ENC-' + id };
  const call = { type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: 'shell_run', arguments: '{"command":"echo hi"}', status: 'completed' };
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_' + id, summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.completed', response: { id, status: 'completed', usage, output: [reasoning, call] } },
  ];
}

function textTurn(id: string, text: string): Frame[] {
  const message = { type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id, status: 'completed', usage, output: [message] } },
  ];
}

async function startFake(): Promise<Fake> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const fake: Fake = {
    url: 'ws://127.0.0.1:' + String(address.port),
    frames: [],
    connections: 0,
    sockets: [],
    onFrame: () => undefined,
    close: () => new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
    }),
  };
  server.on('connection', (socket) => {
    fake.connections += 1;
    fake.sockets.push(socket);
    socket.on('message', (raw) => {
      const frame: Frame = JSON.parse(raw.toString());
      fake.frames.push(frame);
      fake.onFrame(frame, socket, fake.frames.length - 1);
    });
  });
  return fake;
}

const model = responsesModelFor({ modelId: 'gpt-test', baseUrl: 'https://api.openai.com/v1', supportsImages: false, limits: {} });

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 };
}

/** What the HTTP path receives: records the body and answers with a short text turn. */
function fakeHttp(bodies: Array<Record<string, unknown>>): typeof fetch {
  return async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const events = textTurn('resp_http', 'from http');
    return new Response(events.map((event) => 'event: ' + String(event['type']) + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

describe('Responses WebSocket transport', () => {
  let fake: Fake;
  let transport: ResponsesWsTransport;
  let httpBodies: Array<Record<string, unknown>>;

  beforeEach(async () => {
    fake = await startFake();
    transport = createResponsesWsTransport({ endpoint: () => fake.url, idleMs: 60_000 });
    httpBodies = [];
  });
  afterEach(async () => {
    transport.close();
    await fake.close();
  });

  async function run(messages: Message[], options: { key?: string; token?: string; signal?: AbortSignal; transport?: ResponsesWsTransport } = {}) {
    const wsCall = (options.transport ?? transport).forCall({ sessionKey: options.key ?? 'session-a', httpFetch: fakeHttp(httpBodies) });
    const result = await responsesStream(model, normalizeContext({ messages }), {
      apiKey: options.token ?? 'token-1',
      sessionId: 'sid',
      fetch: wsCall.fetch,
      ...(options.signal ? { signal: options.signal } : {}),
    }).result();
    return { result, info: wsCall.info() };
  }

  function continuation(first: AssistantMessage, toolCallId: string): Message[] {
    const toolResult: ToolResultMessage = { role: 'toolResult', toolCallId, toolName: 'shell_run', content: [{ type: 'text', text: 'hi' }], isError: false, timestamp: 3 };
    return [user('start'), first, toolResult];
  }

  it('maps socket events to the same stream result and sends only new items on a continuation', async () => {
    fake.onFrame = (_frame, socket, index) => sendEvents(socket, index === 0 ? toolTurn('resp_1') : index === 1 ? textTurn('resp_2', 'done') : textTurn('resp_3', 'again'));

    const first = await run([user('start')]);
    expect(first.info).toEqual({ transport: 'ws', delta: false });
    expect(first.result.content.some((block) => block.type === 'toolCall')).toBe(true);
    expect(first.result.usage.input).toBeGreaterThan(0);
    expect(fake.frames[0]?.['previous_response_id']).toBeUndefined();
    expect(fake.frames[0]?.['type']).toBe('response.create');
    expect(fake.frames[0]?.['stream']).toBeUndefined();

    const second = await run(continuation(first.result, 'call_resp_1|fc_resp_1'));
    expect(second.info).toMatchObject({ transport: 'ws', delta: true, deltaItems: 1 });
    expect(fake.frames[1]?.['previous_response_id']).toBe('resp_1');
    const secondInput = fake.frames[1]?.['input'] as Array<Record<string, unknown>>;
    expect(secondInput).toHaveLength(1);
    expect(secondInput[0]?.['type']).toBe('function_call_output');
    expect(second.result.content.find((block) => block.type === 'text')).toMatchObject({ text: 'done' });

    const third = await run([...continuation(first.result, 'call_resp_1|fc_resp_1'), second.result, user('more')]);
    expect(third.info).toMatchObject({ delta: true, deltaItems: 1 });
    expect(fake.frames[2]?.['previous_response_id']).toBe('resp_2');
    expect(fake.connections).toBe(1);
  });

  it('records the output from output_item.done when response.completed carries none (as the live endpoint does)', async () => {
    const stripped = (events: Frame[]): Frame[] => events.map((event) => (event['type'] === 'response.completed' ? { ...event, response: { ...(event['response'] as Frame), output: [] } } : event));
    fake.onFrame = (_frame, socket, index) => sendEvents(socket, stripped(index === 0 ? toolTurn('resp_1') : textTurn('resp_2', 'done')));
    const first = await run([user('start')]);
    const second = await run(continuation(first.result, 'call_resp_1|fc_resp_1'));
    expect(second.info).toMatchObject({ delta: true, deltaItems: 1 });
  });

  it('sends the full input when earlier history changed (pruning, compaction)', async () => {
    fake.onFrame = (_frame, socket, index) => sendEvents(socket, index === 0 ? toolTurn('resp_1') : textTurn('resp_' + String(index + 1), 'ok'));
    const first = await run([user('start')]);
    const edited = continuation(first.result, 'call_resp_1|fc_resp_1');
    edited[0] = user('start (compacted)');
    const second = await run(edited);
    expect(second.info).toEqual({ transport: 'ws', delta: false });
    expect(fake.frames[1]?.['previous_response_id']).toBeUndefined();
    expect((fake.frames[1]?.['input'] as unknown[]).length).toBeGreaterThan(2);
  });

  it('sends the full input on a new socket after the old one is gone, and never shares a socket across tokens', async () => {
    fake.onFrame = (_frame, socket) => sendEvents(socket, textTurn('resp_x', 'ok'));
    const first = await run([user('one')]);
    const history = [user('one'), first.result, user('two')];
    const other = await run(history, { token: 'token-2' });
    expect(other.info).toEqual({ transport: 'ws', delta: false });
    expect(fake.connections).toBe(2);
    transport.close();
    const fresh = await run(history);
    expect(fresh.info.delta).toBe(false);
    expect(fake.connections).toBe(3);
  });

  it('retries over HTTP with the full input when the socket answers with an error first', async () => {
    fake.onFrame = (_frame, socket) => sendEvents(socket, [{ type: 'error', status: 400, error: { message: 'previous_response_not_found' } }]);
    const out = await run([user('start')]);
    expect(out.info).toMatchObject({ transport: 'http', fallback: 'error-event' });
    expect(httpBodies).toHaveLength(1);
    expect(httpBodies[0]?.['previous_response_id']).toBeUndefined();
    expect(out.result.content.find((block) => block.type === 'text')).toMatchObject({ text: 'from http' });
  });

  it('falls back to HTTP when the socket closes before any event, then stays on HTTP for a while', async () => {
    fake.onFrame = (_frame, socket) => socket.terminate();
    const out = await run([user('start')]);
    expect(out.info).toMatchObject({ transport: 'http', fallback: 'socket-error' });
    const again = await run([user('start')]);
    expect(again.info).toMatchObject({ transport: 'http', fallback: 'cooldown' });
    expect(fake.connections).toBe(1);
    expect(httpBodies).toHaveLength(2);
  });

  it('falls back to HTTP when the socket cannot be opened', async () => {
    const dead = createResponsesWsTransport({ endpoint: () => 'ws://127.0.0.1:1', connectTimeoutMs: 500 });
    const out = await run([user('start')], { transport: dead });
    expect(out.info.transport).toBe('http');
    expect(out.info.fallback).toMatch(/^connect:/);
    expect(httpBodies).toHaveLength(1);
    dead.close();
  });

  it('a socket that dies mid-response surfaces as a failed turn and moves the session to HTTP', async () => {
    fake.onFrame = (_frame, socket) => {
      sendEvents(socket, textTurn('resp_1', 'partial').slice(0, 4));
      setTimeout(() => socket.terminate(), 10);
    };
    const out = await run([user('start')]);
    expect(out.result.stopReason).toBe('error');
    const retry = await run([user('start')]);
    expect(retry.info).toMatchObject({ transport: 'http', fallback: 'cooldown' });
  });

  it('stop aborts the in-flight response, closes the socket, and the next call starts on a new one', async () => {
    fake.onFrame = (_frame, socket, index) => {
      if (index === 0) sendEvents(socket, textTurn('resp_1', 'slow').slice(0, 2));
      else sendEvents(socket, textTurn('resp_2', 'ok'));
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const stopped = await run([user('start')], { signal: controller.signal });
    expect(stopped.result.stopReason).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sockets[0]?.readyState).toBe(3);
    const next = await run([user('start')]);
    expect(next.info).toEqual({ transport: 'ws', delta: false });
    expect(fake.connections).toBe(2);
  });

  it('leaves every other endpoint on HTTP', async () => {
    expect(defaultEndpoint('https://api.openai.com/v1/responses')).toBe('wss://api.openai.com/v1/responses');
    expect(defaultEndpoint('https://example.com/v1/responses')).toBeUndefined();
    expect(defaultEndpoint('http://api.openai.com/v1/responses')).toBeUndefined();
    const plain = createResponsesWsTransport();
    const wsCall = plain.forCall({ sessionKey: 'k', httpFetch: fakeHttp(httpBodies) });
    await wsCall.fetch('https://example.com/v1/responses', { method: 'POST', body: JSON.stringify({ input: [] }) });
    expect(wsCall.info()).toEqual({ transport: 'http', delta: false });
    expect(httpBodies).toHaveLength(1);
  });
});

describe('decideDelta', () => {
  const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
  const state = { responseId: 'resp_1', rest: 'r', inputHashes: [] as string[], output: [message] };

  it('requires the previous output to be replayed in order, with something new after it', () => {
    expect(decideDelta(state, 'r', [message])).toEqual({ delta: false });
    expect(decideDelta(state, 'other', [message, { role: 'user' }])).toEqual({ delta: false });
    expect(decideDelta(state, 'r', [{ ...message, content: [{ type: 'output_text', text: 'changed' }] }, { role: 'user' }])).toEqual({ delta: false });
    expect(decideDelta(state, 'r', [message, { role: 'user' }])).toEqual({ delta: true, previousResponseId: 'resp_1', input: [{ role: 'user' }] });
  });
});
