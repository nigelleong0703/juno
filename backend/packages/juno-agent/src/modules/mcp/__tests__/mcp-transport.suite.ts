// PH7 transport: real JSON and SSE streamable transport, protocol-version/session headers, strict
// id matching, CRLF framing, open streams, bounded bodies, timely cancellation, pagination.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  HttpMcpTransport,
  McpAuthError,
  McpCancelledError,
  McpClient,
  McpProtocolError,
  StdioMcpTransport,
  McpUnsupportedError,
  createMcpClient,
} from '../index.js';
import { countingStdioBridge, fakeStdioBridge, silentStdioBridge, startFixture, textOf, waitFor, type Fixture } from './mcp-runtime.fixtures.js';

describe('PH7 MCP transport', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('initializes, negotiates the protocol version and echoes session + version headers', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.url });
    const status = await client.connect();
    expect(status).toMatchObject({ state: 'connected', protocolVersion: '2024-11-05', serverName: 'fixture', serverVersion: '1.2.3' });
    await client.listTools();
    expect(fixture.state.sessions).toContain('sess-fixture-1');
    expect(fixture.state.protocolVersions).toContain('2024-11-05');
    await client.close();
  });

  it('discovers and invokes tools over JSON', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.url });
    await client.connect();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo', 'big', 'fail', 'slow', 'image', 'structured', 'audio', 'huge', 'oversized']);
    expect(textOf(await client.callTool('echo', { text: 'hello' }))).toBe('echo:hello');
    await client.close();
  });

  it('preserves real images and structured content and flags unsupported media', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.url });
    await client.connect();
    const image = await client.callTool('image', {});
    expect(image.parts).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' });
    const structured = await client.callTool('structured', {});
    expect(structured.structured ?? '').toContain('"verdict"');
    expect(structured.text).toContain('structured');
    const audio = await client.callTool('audio', {});
    expect(audio.unsupported).toContain('audio');
    expect(audio.text).toContain('unsupported content omitted');
    await client.close();
  });

  it('speaks the SSE and CRLF SSE transports for the same operations', async () => {
    for (const url of [fixture.sseUrl, fixture.crlfUrl]) {
      const client = createMcpClient({ transport: 'http', url });
      expect((await client.connect()).state).toBe('connected');
      expect(textOf(await client.callTool('echo', { text: 'sse' }))).toBe('echo:sse');
      await client.close();
    }
  });

  it('resolves an SSE response that stays open and releases the stream', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.openUrl });
    expect((await client.connect()).state).toBe('connected');
    expect((await client.listTools()).map((tool) => tool.name)).toContain('echo');
    await client.close();
  });

  it('rejects a JSON response whose id does not match the request', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.wrongIdUrl });
    await client.connect();
    await expect(client.callTool('echo', {})).rejects.toBeInstanceOf(McpProtocolError);
    await client.close();
  });

  it('surfaces a JSON-RPC tool error and bounds a large streamed result', async () => {
    const plain = createMcpClient({ transport: 'http', url: fixture.url });
    await plain.connect();
    await expect(plain.callTool('fail', {})).rejects.toBeInstanceOf(McpProtocolError);
    expect((await plain.callTool('big', {})).truncated).toBe(true);
    await plain.close();

    const bounded = new McpClient(() => new HttpMcpTransport({ url: fixture.bigUrl, maxBytes: 1000 }));
    await bounded.connect();
    await expect(bounded.callTool('echo', {})).rejects.toBeInstanceOf(McpProtocolError);
    await bounded.close();
  });

  it('cancels promptly and notifies the server even when it never answers the notification', async () => {
    const client = new McpClient(() => new HttpMcpTransport({ url: fixture.hangUrl, notifyTimeoutMs: 200 }));
    await client.connect();
    const before = fixture.state.cancelled.length;
    const controller = new AbortController();
    const pending = client.callTool('slow', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await expect(pending).rejects.toBeInstanceOf(McpCancelledError);
    expect(Date.now() - started).toBeLessThan(3000);
    await waitFor(() => fixture.state.cancelled.length > before, 1000);
    expect(fixture.state.cancelled.length).toBeGreaterThan(before);
    await client.close();
  });

  it('pages tools/list to the end and marks a bounded catalog as truncated', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.pagesUrl });
    await client.connect();
    const discovery = await client.discoverTools();
    expect(discovery.tools.map((tool) => tool.name)).toEqual(['echo', 'beta']);
    expect(discovery.truncated).toBe(false);
    await client.close();

    const capped = new McpClient(() => new HttpMcpTransport({ url: fixture.pagesUrl }), { maxTools: 1 });
    await capped.connect();
    const limited = await capped.discoverTools();
    expect(limited.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(limited.truncated).toBe(true);
    await capped.close();
  });

  it('reports truthful auth/server failure state', async () => {
    const auth = createMcpClient({ transport: 'http', url: fixture.authUrl });
    await expect(auth.connect()).rejects.toBeInstanceOf(McpAuthError);
    expect(auth.getStatus()).toEqual({ state: 'error', detail: 'unauthorized' });

    const broken = createMcpClient({ transport: 'http', url: fixture.errorUrl });
    await expect(broken.connect()).rejects.toBeInstanceOf(McpProtocolError);
    expect(broken.getStatus()).toEqual({ state: 'error', detail: 'protocol-500' });
  });

  it('disconnects and recovers on reconnect', async () => {
    const client = createMcpClient({ transport: 'http', url: fixture.url });
    await client.connect();
    await client.close();
    expect(client.getStatus().state).toBe('disconnected');
    expect((await client.reconnect()).state).toBe('connected');
    expect(textOf(await client.callTool('echo', { text: 'again' }))).toBe('echo:again');
    await client.close();
  });

  it('runs stdio only through the sandbox bridge and never spawns on the host', async () => {
    expect(() => createMcpClient({ transport: 'stdio', command: 'npx', args: [] })).toThrow(McpUnsupportedError);
    const client = createMcpClient({ transport: 'stdio', command: 'fixture', args: [] }, { stdio: fakeStdioBridge() });
    expect((await client.connect()).state).toBe('connected');
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo', 'big', 'fail', 'slow', 'image', 'structured', 'audio', 'huge', 'oversized']);
    expect(textOf(await client.callTool('echo', { text: 'stdio' }))).toBe('echo:stdio');
    await client.close();
  });

  it('fails pending stdio calls promptly when the sandbox server exits', async () => {
    const silent = silentStdioBridge();
    const client = createMcpClient({ transport: 'stdio', command: 'silent', args: [] }, { stdio: silent.bridge });
    await client.connect();
    const pending = client.callTool('echo', {});
    await silent.fireExit();
    await expect(pending).rejects.toBeInstanceOf(McpProtocolError);
    await client.close();
  });

  it('opens nothing and sends nothing for an already-cancelled stdio call', async () => {
    const counted = countingStdioBridge();
    const client = createMcpClient({ transport: 'stdio', command: 'counted', args: [] }, { stdio: counted.bridge });
    await client.connect();
    const opens = counted.counts.opens;
    const requests = counted.counts.requests;
    const controller = new AbortController();
    controller.abort();
    await expect(client.callTool('echo', {}, { signal: controller.signal })).rejects.toBeInstanceOf(McpCancelledError);
    expect(counted.counts.opens).toBe(opens);
    expect(counted.counts.requests).toBe(requests);
    await client.close();
  });

  it('sends no request when a stdio call is cancelled while the bridge opens', async () => {
    const counted = countingStdioBridge({ openDelayMs: 100 });
    // A fresh transport: the first request is what triggers the (delayed) bridge open.
    const transport = new StdioMcpTransport({ bridge: counted.bridge, command: 'counted', args: [] });
    const controller = new AbortController();
    const pending = transport.request(1, 'tools/call', { name: 'echo', arguments: {} }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeTruthy();
    expect(counted.counts.opens).toBe(1);
    expect(counted.counts.requests).toBe(0);
    await transport.close();
  });
});
