import { type Hono } from 'hono';
import { createLogger } from '@agent-desktop/log';
import { AUDIO_FORMATS, createTranscriber, type AudioFormat, type Transcriber } from 'juno-agent/modules/transcription';
import { getOwnerId } from '../auth.js';

const log = createLogger({ service: 'agentd' });

/** OpenAI-compatible endpoints take files up to 25 MB; a spoken message is far smaller. */
const MAX_BYTES = 25 * 1024 * 1024;

const isAudioFormat = (value: string): value is AudioFormat => Object.hasOwn(AUDIO_FORMATS, value);

/**
 * Dictation for the composer (BACKEND "听写"): the app posts one recording as the raw request body (Content-Type names
 * the container) and gets its text back to put in the message box. Nothing is stored and no agent is woken.
 */
export function registerTranscriptions(app: Hono, transcriber: Transcriber | undefined = createTranscriber(process.env)) {
  app.post('/v1/transcriptions', async (c) => {
    getOwnerId(c);
    if (transcriber === undefined) {
      return c.json({ error: { code: 'TRANSCRIPTION_UNAVAILABLE', message: 'Speech-to-text is not configured on this server' } }, 503);
    }
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!isAudioFormat(type)) {
      return c.json({ error: { code: 'UNSUPPORTED_AUDIO', message: 'Send the recording as ' + Object.keys(AUDIO_FORMATS).join(', ') } }, 415);
    }
    const audio = Buffer.from(await c.req.arrayBuffer());
    if (audio.length === 0) return c.json({ error: { code: 'EMPTY_AUDIO', message: 'The recording is empty' } }, 400);
    if (audio.length > MAX_BYTES) return c.json({ error: { code: 'AUDIO_TOO_LARGE', message: 'Recordings are limited to 25 MB' } }, 413);
    try {
      return c.json({ text: await transcriber.transcribe(audio, c.req.raw.signal, type) });
    } catch (error) {
      log.warn({ err: error }, 'transcription failed');
      return c.json({ error: { code: 'TRANSCRIPTION_FAILED', message: 'Could not transcribe the recording; try again' } }, 502);
    }
  });
}
