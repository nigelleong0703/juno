/** Spoken replies: the first part is ready when POST answers, later parts are made in the background, owner-scoped urls, and the 503 that means "speak on the device". */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import { speechResponseSchema } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders } from '../../__tests__/test-app.js';
import { createSpeaker, SpeechUnavailable, type SpeechPart, type Speaker } from '../speech.js';

const mem = createMemoryStore();
const part = (text: string, format: SpeechPart['format'] = 'm4a'): SpeechPart => ({ text, durationMs: 1000, format, audio: Buffer.from(`audio:${text}`) });
const appWith = (speaker?: Speaker) => createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer(), ...(speaker ? { speaker } : {}) });
type App = ReturnType<typeof appWith>;
const post = (app: App, owner: string, body: unknown) =>
  app.request('/v1/speech', { method: 'POST', headers: ownerHeaders(owner, true), body: JSON.stringify(body) });
const get = (app: App, owner: string, url: string) => app.request(url, { headers: ownerHeaders(owner) });

/** A speaker whose later parts finish only when the test says so; records the order parts were asked for. */
function gatedSpeaker(texts: string[], failing: string[] = []) {
  const asked: string[] = [];
  const gates = new Map<string, () => void>();
  const speaker: Speaker = {
    split: async () => texts,
    speak: async ({ text }) => {
      asked.push(text);
      if (text === texts[0]) return part(text);
      await new Promise<void>((resolve) => gates.set(text, resolve));
      if (failing.includes(text)) throw new Error('boom');
      return part(text, text === 'Third.' ? 'wav' : 'm4a');
    },
  };
  return { speaker, asked, release: (text: string) => gates.get(text)?.() };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('POST /v1/speech', () => {
  it('answers with every url as soon as the first part is made, then makes the rest in order, one at a time', async () => {
    const { speaker, asked, release } = gatedSpeaker(['First.', 'Second.', 'Third.']);
    const app = appWith(speaker);
    const res = await post(app, 'owner-a', { text: 'First. Second. Third.' });
    expect(res.status).toBe(200);
    const { parts } = speechResponseSchema.parse(await res.json());
    expect(parts.map((p) => p.text)).toEqual(['First.', 'Second.', 'Third.']);
    expect(parts.map((p) => p.durationMs)).toEqual([1000, undefined, undefined]);

    const first = await get(app, 'owner-a', parts[0]!.url);
    expect(first.headers.get('content-type')).toBe('audio/mp4');
    expect(Buffer.from(await first.arrayBuffer()).toString()).toBe('audio:First.');

    // The second part is under way; the third has not been asked for yet.
    await tick();
    expect(asked).toEqual(['First.', 'Second.']);
    const waiting = get(app, 'owner-a', parts[1]!.url);
    release('Second.');
    expect(Buffer.from(await (await waiting).arrayBuffer()).toString()).toBe('audio:Second.');
    await tick();
    expect(asked).toEqual(['First.', 'Second.', 'Third.']);
    release('Third.');
    expect((await get(app, 'owner-a', parts[2]!.url)).headers.get('content-type')).toBe('audio/wav');

    expect((await get(app, 'owner-b', parts[0]!.url)).status).toBe(404);
    expect((await app.request(parts[0]!.url)).status).toBe(401);
    expect((await get(app, 'owner-a', '/v1/speech/unknown')).status).toBe(404);
  });

  it('a part that failed in the background answers 502 on its own url, and later parts still play', async () => {
    const { speaker, release } = gatedSpeaker(['First.', 'Second.', 'Third.'], ['Second.']);
    const app = appWith(speaker);
    const { parts } = speechResponseSchema.parse(await (await post(app, 'owner-a', { text: 'x' })).json());
    await tick();
    release('Second.');
    expect((await get(app, 'owner-a', parts[1]!.url)).status).toBe(502);
    await tick();
    release('Third.');
    expect((await get(app, 'owner-a', parts[2]!.url)).status).toBe(200);
  });

  it('refuses empty or over-long text and a bad language before calling the sidecar', async () => {
    const never = () => { throw new Error('must not be called'); };
    const app = appWith({ split: never, speak: never });
    expect((await post(app, 'owner-a', { text: '   ' })).status).toBe(400);
    expect((await post(app, 'owner-a', { text: 'a'.repeat(2001) })).status).toBe(400);
    expect((await post(app, 'owner-a', { text: 'hi', lang: 'fr' })).status).toBe(400);
    expect((await app.request('/v1/speech', { method: 'POST', body: '{"text":"hi"}' })).status).toBe(401);
  });

  it('answers 503 SPEECH_UNAVAILABLE when speech is off or the sidecar is down, 502 when the first part fails, 400 when nothing is speakable', async () => {
    const off = await post(appWith(), 'owner-a', { text: 'hi' });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: { code: 'SPEECH_UNAVAILABLE' } });

    const down = async () => { throw new SpeechUnavailable('down'); };
    expect((await post(appWith({ split: down, speak: down }), 'owner-a', { text: 'hi' })).status).toBe(503);

    const broken = await post(appWith({ split: async () => ['hi'], speak: async () => { throw new Error('boom'); } }), 'owner-a', { text: 'hi' });
    expect(broken.status).toBe(502);
    expect(await broken.json()).toMatchObject({ error: { code: 'SPEECH_FAILED' } });

    expect((await post(appWith({ split: async () => [], speak: down }), 'owner-a', { text: '...' })).status).toBe(400);
  });
});

describe('the sidecar client', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  it('is absent unless TTS_ENABLED=1', () => {
    expect(createSpeaker({})).toBeUndefined();
    expect(createSpeaker({ TTS_ENABLED: '0' })).toBeUndefined();
  });

  it('splits then speaks part by part, and reports a refused connection as unavailable', async () => {
    const seen: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        seen.push(`${req.url} ${body}`);
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/split'
          ? JSON.stringify({ parts: ['Hi.', 'There.'] })
          : JSON.stringify({ text: 'Hi.', durationMs: 500, format: 'm4a', audio: Buffer.from('bytes').toString('base64') }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const speaker = createSpeaker({ TTS_ENABLED: '1', TTS_PORT: String(port) })!;

    expect(await speaker.split('Hi. There.')).toEqual(['Hi.', 'There.']);
    expect(await speaker.speak({ text: 'Hi.', lang: 'en' })).toEqual({ text: 'Hi.', durationMs: 500, format: 'm4a', audio: Buffer.from('bytes') });
    expect(seen).toEqual(['/split {"text":"Hi. There."}', '/speak {"text":"Hi.","lang":"en"}']);

    server.close();
    await expect(speaker.split('Hi.')).rejects.toBeInstanceOf(SpeechUnavailable);
  });
});
