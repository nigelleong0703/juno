/**
 * Platform transcription service: an OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * Configured by TRANSCRIPTION_BASE_URL (for example https://api.openai.com/v1), TRANSCRIPTION_API_KEY and
 * TRANSCRIPTION_MODEL (default whisper-1). Without a base URL and key there is no transcriber, and every
 * caller says so instead of guessing. Callers hand over 16-bit mono PCM; the WAV wrapper lives here so
 * the Discord voice session, the Slack huddle skill and anything later share one path.
 */

export interface Transcriber {
  /**
   * The text of one audio clip (empty when nothing was said). Throws on a transport or provider failure. `format` names
   * the container when it is not WAV (an app's recording: m4a, webm, ogg, mp3); the provider reads it from the file name.
   */
  transcribe(audio: Buffer, signal?: AbortSignal, format?: AudioFormat): Promise<string>;
}

/** Recording containers the apps send; every one is accepted by OpenAI-compatible transcription endpoints. */
export const AUDIO_FORMATS = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' } as const;
export type AudioFormat = keyof typeof AUDIO_FORMATS;

/** Wraps little-endian 16-bit mono PCM in a WAV container. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The configured transcriber, or undefined when TRANSCRIPTION_BASE_URL / TRANSCRIPTION_API_KEY are not both set. */
export function createTranscriber(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Transcriber | undefined {
  const base = env['TRANSCRIPTION_BASE_URL']?.trim() ?? '';
  const key = env['TRANSCRIPTION_API_KEY']?.trim() ?? '';
  if (base.length === 0 || key.length === 0) return undefined;
  const model = env['TRANSCRIPTION_MODEL']?.trim() || 'whisper-1';
  const url = base.replace(/\/+$/, '') + '/audio/transcriptions';
  return {
    async transcribe(audio, signal, format = 'audio/wav') {
      const form = new FormData();
      form.append('model', model);
      form.append('response_format', 'json');
      form.append('file', new Blob([new Uint8Array(audio)], { type: format }), 'audio.' + AUDIO_FORMATS[format]);
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(`transcription failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      const text = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['text'] : undefined;
      return typeof text === 'string' ? text.trim() : '';
    },
  };
}
