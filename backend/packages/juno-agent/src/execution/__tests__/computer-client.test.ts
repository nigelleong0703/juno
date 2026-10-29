import { describe, it, expect } from 'vitest';
import { ComputerError } from '../../modules/tools/index.js';
import { loadConfig } from '../config.js';
import { createComputerdClient, selectComputerdClient } from '../infrastructure/computerd-executor/index.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function responseFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl, calls };
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') return {};
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('computerd config gate', () => {
  it('leaves the computer disabled unless COMPUTERD_URL is set explicitly', () => {
    const messages: string[] = [];
    const log = (fields: Record<string, unknown>, message: string) => {
      void fields;
      messages.push(message);
    };
    expect(selectComputerdClient({}, loadConfig({}), log)).toBeUndefined();
    expect(selectComputerdClient({ COMPUTERD_URL: 'http://127.0.0.1:9090' }, loadConfig({ COMPUTERD_TOKEN: 'cfg-token' }), log)).toBeDefined();
    expect(messages).toEqual([
      'Computer disabled: set COMPUTERD_URL to enable computer/shell/file/browser tools',
      'Computer sandbox enabled (computerd)',
    ]);
  });

  it('sends the configured COMPUTERD_TOKEN as the bearer', async () => {
    const realFetch = globalThis.fetch;
    const calls: Captured[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: 'png', width: 1, height: 1, displayNo: 1 }), { status: 200 });
    };
    try {
      const client = selectComputerdClient({ COMPUTERD_URL: 'http://c.test' }, loadConfig({ COMPUTERD_TOKEN: 'cfg-token' }), () => {}, async () => 'alice');
      if (!client) throw new Error('expected client');
      await client.screenshot('agent-1', new AbortController().signal);
      expect(header(calls[0]?.init, 'authorization')).toBe('Bearer cfg-token');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
  });

  it('fails at selection time naming COMPUTERD_TOKEN when no token is configured (no built-in default)', () => {
    expect(() => selectComputerdClient({ COMPUTERD_URL: 'http://c.test' }, loadConfig({}))).toThrow(
      /COMPUTERD_TOKEN/,
    );
  });
});

describe('computerd HTTP adapter', () => {
  it('scopes a screenshot to the requesting agent and parses size and display', async () => {
    const fake = responseFetch({ data: 'png', width: 1280, height: 800, displayNo: 2 });
    const client = createComputerdClient({ baseUrl: 'http://computerd.test', token: 'secret', fetch: fake.fetch });
    const shot = await client.screenshot('agent-1', new AbortController().signal);
    expect(shot).toEqual({ data: 'png', mimeType: 'image/png', width: 1280, height: 800, displayNo: 2 });
    expect(fake.calls[0]?.url).toBe('http://computerd.test/v1/screens/self/screenshot');
    expect(header(fake.calls[0]?.init, 'x-agent-id')).toBe('agent-1');
    expect(header(fake.calls[0]?.init, 'authorization')).toBe('Bearer secret');
  });

  it('sends click coordinates and input actions to the agent screen endpoint', async () => {
    const fake = responseFetch({});
    const client = createComputerdClient({ baseUrl: 'http://computerd.test', fetch: fake.fetch });
    const signal = new AbortController().signal;
    await client.click('agent-1', { x: 4, y: 5 }, signal);
    await client.type('agent-1', 'hello', signal);
    await client.pressKey('agent-1', 'Return', signal);
    await client.scroll('agent-1', { deltaY: -120 }, signal);
    expect(fake.calls.map((call) => call.url.replace('http://computerd.test/v1/screens/self/', ''))).toEqual([
      'click',
      'type',
      'key',
      'scroll',
    ]);
    expect(parseBody(fake.calls[0]?.init)).toEqual({ x: 4, y: 5 });
    expect(parseBody(fake.calls[3]?.init)).toEqual({ deltaY: -120 });
  });

  it('marks Mac desktop, browser and recording calls without changing the sandbox default', async () => {
    const fake = responseFetch({ data: 'png', mimeType: 'image/png', width: 1600, height: 1000 });
    const client = createComputerdClient({ baseUrl: 'http://computerd.test', fetch: fake.fetch });
    const signal = new AbortController().signal;
    await client.screenshot('agent-1', signal);
    expect(header(fake.calls[0]?.init, 'x-computer')).toBeNull();
    // The coordinate screen actions are gone on the Mac: they fail here, they never fall through to the sandbox.
    await expect(client.screenshot('agent-1', signal, 'mac')).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(client.click('agent-1', { x: 1, y: 2 }, signal, 'mac')).rejects.toMatchObject({ code: 'not_allowed' });
    expect(fake.calls).toHaveLength(1);

    const desktop = responseFetch({ ok: true, text: 'tree', needsForeground: true, image: { mimeType: 'image/png', data: 'AAAA' } });
    const desktopClient = createComputerdClient({ baseUrl: 'http://computerd.test', fetch: desktop.fetch });
    if (desktopClient.macDesktop === undefined) throw new Error('expected Mac desktop support');
    expect(await desktopClient.macDesktop('agent-1', 'act', { app: 'Notes', steps: [{ tool: 'click' }] }, signal)).toEqual({ ok: true, text: 'tree', needsForeground: true, image: { mimeType: 'image/png', data: 'AAAA' } });
    expect(header(desktop.calls[0]?.init, 'x-computer')).toBe('mac');
    expect(String(desktop.calls[0]?.url)).toContain('/v1/screens/self/mac/act');
    expect(parseBody(desktop.calls[0]?.init)).toEqual({ app: 'Notes', steps: [{ tool: 'click' }] });
    const odd = createComputerdClient({ baseUrl: 'http://computerd.test', fetch: responseFetch({ nope: 1 }).fetch });
    await expect(odd.macDesktop?.('agent-1', 'snapshot', { app: 'Notes' }, signal)).rejects.toMatchObject({ code: 'failed' });

    const browser = responseFetch({ action: 'tabs', tabs: [] });
    const browserClient = createComputerdClient({ baseUrl: 'http://computerd.test', fetch: browser.fetch });
    const browserAction = browserClient.browser;
    if (browserAction === undefined) throw new Error('expected browser support');
    await browserAction('agent-1', { action: 'tabs' }, signal, 'mac');
    expect(header(browser.calls[0]?.init, 'x-computer')).toBe('mac');

    const audio = responseFetch({ recordingId: 'r1', path: '/Users/robin/Juno/r1.wav', state: 'recording' });
    const audioClient = createComputerdClient({ baseUrl: 'http://computerd.test', fetch: audio.fetch });
    const recordAudio = audioClient.recordAudio;
    if (recordAudio === undefined) throw new Error('expected recording support');
    expect(await recordAudio('agent-1', { action: 'start', maxDurationSeconds: 1800 }, signal, 'mac')).toEqual({
      recordingId: 'r1', path: '/Users/robin/Juno/r1.wav', state: 'recording',
    });
    expect(header(audio.calls[0]?.init, 'x-computer')).toBe('mac');
    expect(parseBody(audio.calls[0]?.init)).toEqual({ action: 'start', maxDurationSeconds: 1800 });
  });

  it('parses shell, file and navigation results', async () => {
    const shell = responseFetch({ stdout: 'out', stderr: 'err', exitCode: 3 });
    const shellClient = createComputerdClient({ baseUrl: 'http://c.test', fetch: shell.fetch });
    expect(await shellClient.runShell('agent-1', { command: 'ls', timeoutMs: 1000 }, new AbortController().signal)).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
    });
    expect(parseBody(shell.calls[0]?.init)).toEqual({ command: 'ls', timeoutMs: 1000 });

    const file = responseFetch({ content: 'hi' });
    const fileClient = createComputerdClient({ baseUrl: 'http://c.test', fetch: file.fetch });
    expect(await fileClient.readFile('agent-1', '/workspace/x', new AbortController().signal)).toEqual({ content: 'hi', bytes: 2 });
    expect(await fileClient.writeFile('agent-1', { path: '/workspace/x', content: 'hi' }, new AbortController().signal)).toEqual({
      path: '/workspace/x',
      bytes: 0,
    });

    const nav = responseFetch({ url: 'https://example.com', title: 'T' });
    const navClient = createComputerdClient({ baseUrl: 'http://c.test', fetch: nav.fetch });
    expect(await navClient.navigate('agent-1', 'https://example.com', new AbortController().signal)).toEqual({
      url: 'https://example.com',
      title: 'T',
    });
  });

  it('maps a takeover conflict to user_control so the tool can tell the model to screenshot again', async () => {
    const fake = responseFetch({ code: 'user_control', message: 'user has the screen' }, 409);
    const client = createComputerdClient({ baseUrl: 'http://c.test', fetch: fake.fetch });
    await expect(client.click('agent-1', { x: 1, y: 1 }, new AbortController().signal)).rejects.toMatchObject({
      code: 'user_control',
      message: 'user has the screen',
    });
  });

  it('maps auth, missing-screen and unavailable statuses to stable codes', async () => {
    const cases: Array<{ status: number; code: string }> = [
      { status: 403, code: 'not_allowed' },
      { status: 404, code: 'no_screen' },
      { status: 503, code: 'unavailable' },
    ];
    for (const testCase of cases) {
      const fake = responseFetch({}, testCase.status);
      const client = createComputerdClient({ baseUrl: 'http://c.test', fetch: fake.fetch });
      const error: unknown = await client.screenshot('agent-1', new AbortController().signal).catch((thrown) => thrown);
      expect(error).toBeInstanceOf(ComputerError);
      expect(error).toMatchObject({ code: testCase.code });
    }
  });

  it('reports a malformed computerd payload as a failure instead of acting on junk', async () => {
    const fake = responseFetch({ notScreenshot: true });
    const client = createComputerdClient({ baseUrl: 'http://c.test', fetch: fake.fetch });
    await expect(client.screenshot('agent-1', new AbortController().signal)).rejects.toMatchObject({ code: 'failed' });
  });

  it('forwards the abort signal so a stop cancels the in-flight request', async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(init?.signal);
      throw new DOMException('aborted', 'AbortError');
    };
    const client = createComputerdClient({ baseUrl: 'http://c.test', fetch: fetchImpl });
    await expect(client.screenshot('agent-1', controller.signal)).rejects.toThrow();
    expect(seen[0]?.aborted).toBe(true);
  });
});
