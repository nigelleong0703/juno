import { randomUUID } from 'node:crypto';
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createLogger } from '@agent-desktop/log';
import { speechRequestSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';

const log = createLogger({ service: 'agentd' });

/** One sentence-sized piece of a spoken reply. */
export interface SpeechPart {
  text: string;
  durationMs: number;
  format: 'm4a' | 'wav';
  audio: Buffer;
}

export interface Speaker {
  /** The text cut into parts in playback order (the first sentence alone). Throws SpeechUnavailable when the sidecar cannot be reached. */
  split(text: string, signal?: AbortSignal): Promise<string[]>;
  /** One part as audio. Throws SpeechUnavailable when the sidecar cannot be reached, anything else on failure. */
  speak(part: { text: string; lang?: 'en' | 'zh' }, signal?: AbortSignal): Promise<SpeechPart>;
}

export class SpeechUnavailable extends Error {}

/** Audio is kept in memory for this long (never in Postgres: it is a throwaway rendering of a reply the DB already holds). */
const TTL_MS = 10 * 60 * 1000;
/** How long a GET waits for a part that is still being synthesized. */
const WAIT_MS = 20_000;
const SIDECAR_TIMEOUT_MS = 60_000;

const MIME = { m4a: 'audio/mp4', wav: 'audio/wav' } as const;

/** The loopback Kokoro sidecar (services/tts), or undefined unless TTS_ENABLED=1. */
export function createSpeaker(env: NodeJS.ProcessEnv): Speaker | undefined {
  if (env['TTS_ENABLED'] !== '1') return undefined;
  const base = `http://127.0.0.1:${env['TTS_PORT'] ?? '8792'}`;
  async function call<T>(path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SpeechUnavailable('the speech sidecar is not reachable', { cause: error });
    }
    if (!response.ok) throw new Error(`speech sidecar answered ${response.status}`);
    return (await response.json()) as T;
  }
  return {
    async split(text, signal) {
      return (await call<{ parts: string[] }>('/split', { text }, signal)).parts;
    },
    async speak(part, signal) {
      const body = await call<{ text: string; durationMs: number; format: SpeechPart['format']; audio: string }>('/speak', part, signal);
      return { text: body.text, durationMs: body.durationMs, format: body.format, audio: Buffer.from(body.audio, 'base64') };
    },
  };
}

interface Entry {
  ownerId: string;
  /** Settles when the part is synthesized; rejects if that failed. */
  part: Promise<SpeechPart>;
  expiresAt: number;
}

/**
 * Spoken replies for the Apple Watch (BACKEND "语音回复"): `POST /v1/speech` splits the text, synthesizes only the first part, and
 * returns one url per part at once; the rest are synthesized in the background in order. `GET /v1/speech/:id` serves a part to its
 * owner (waiting for it if it is still being made). Nothing is stored beyond the in-memory cache.
 */
export function registerSpeech(app: Hono, speaker: Speaker | undefined = createSpeaker(process.env)) {
  const cache = new Map<string, Entry>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expiresAt <= now) cache.delete(id);
  };

  app.post('/v1/speech', zValidator('json', speechRequestSchema), async (c) => {
    const ownerId = getOwnerId(c);
    if (speaker === undefined) {
      return c.json({ error: { code: 'SPEECH_UNAVAILABLE', message: 'Spoken replies are not enabled on this server; speak on the device instead' } }, 503);
    }
    const { text, lang } = c.req.valid('json');
    const signal = c.req.raw.signal;
    const speakPart = (part: string, withSignal?: AbortSignal) => speaker.speak({ text: part, ...(lang ? { lang } : {}) }, withSignal);
    try {
      const texts = await speaker.split(text, signal);
      if (texts.length === 0) return c.json({ error: { code: 'NOTHING_TO_SPEAK', message: 'The text has nothing to say aloud' } }, 400);
      const first = await speakPart(texts[0]!, signal);
      sweep();
      const expiresAt = Date.now() + TTL_MS;
      // The rest run one at a time, in order, after the response; each GET awaits its own part.
      let previous: Promise<unknown> = Promise.resolve();
      const parts = texts.map((partText, index) => {
        const id = randomUUID();
        let part: Promise<SpeechPart>;
        if (index === 0) {
          part = Promise.resolve(first);
        } else {
          part = previous.then(() => speakPart(partText));
          part.catch((error: unknown) => log.warn({ err: error }, 'speech part failed'));
        }
        previous = part.catch(() => undefined);
        cache.set(id, { ownerId, part, expiresAt });
        return { url: `/v1/speech/${id}`, text: partText, ...(index === 0 ? { durationMs: first.durationMs } : {}) };
      });
      return c.json({ parts });
    } catch (error) {
      if (error instanceof SpeechUnavailable) {
        log.warn({ err: error }, 'speech sidecar unavailable');
        return c.json({ error: { code: 'SPEECH_UNAVAILABLE', message: 'The speech service is not running; speak on the device instead' } }, 503);
      }
      log.warn({ err: error }, 'speech failed');
      return c.json({ error: { code: 'SPEECH_FAILED', message: 'Could not speak the reply; try again' } }, 502);
    }
  });

  app.get('/v1/speech/:id', async (c) => {
    const ownerId = getOwnerId(c);
    sweep();
    const entry = cache.get(c.req.param('id'));
    if (entry === undefined || entry.ownerId !== ownerId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'This audio has expired' } }, 404);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), WAIT_MS); });
    try {
      const part = await Promise.race([entry.part, timeout]);
      if (part === 'timeout') return c.json({ error: { code: 'SPEECH_PENDING', message: 'This part is not ready yet; try again' } }, 504);
      return c.body(new Uint8Array(part.audio), 200, { 'content-type': MIME[part.format], 'cache-control': 'private, max-age=600' });
    } catch {
      return c.json({ error: { code: 'SPEECH_FAILED', message: 'Could not speak this part' } }, 502);
    } finally {
      clearTimeout(timer);
    }
  });
}
