import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../index.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, ToolContext } from '../../../contracts/index.js';
import type { VoicePort } from '../tools/discordVoice.js';
import { createTranscriber, pcm16ToWav } from '../../transcription.js';

const enqueuer: Enqueuer = {
  async enqueue() { return { accepted: true }; },
  async stopRun() {},
  async resolveAwakeable() {},
  async scheduleRoutine() {},
};

const port: VoicePort = {
  async join(input) { return { ok: true, text: `joined ${input.channelId ?? 'owner channel'} from ${input.conversationId}` }; },
  async leave() { return { ok: true, text: 'left' }; },
  async transcript() { return { ok: true, text: 'lines' }; },
};

function ctx(trusted: boolean): ToolContext {
  return { ownerId: 'o1', agentId: 'a1', conversationId: 'cvn-1', wake: { trusted } } as unknown as ToolContext;
}

describe('discord voice tools', () => {
  it('are offered only to an agent that has a discord channel', async () => {
    const store = createMemoryStore();
    const registry = await createToolRegistry({ store, enqueuer, voice: port });
    const names = async (agentId: string): Promise<string[]> => (await registry.forAgent(agentId)).map((tool) => tool.name);
    expect(await names('a1')).not.toContain('discord_voice_join');
    await store.put('channels', {
      id: 'discord:1', ownerId: 'o1', agentId: 'a1', kind: 'discord', channelId: '1', secretHashHex: 'x'.repeat(64),
      status: 'active', createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(await names('a1')).toEqual(expect.arrayContaining(['discord_voice_join', 'discord_voice_leave', 'discord_voice_transcript']));
    expect(await names('a2')).not.toContain('discord_voice_join');
  });

  it('discord_voice_join is owner-only and passes the conversation through', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer, voice: port });
    const join = registry.get('discord_voice_join');
    const refused = await join?.execute({ channelId: 'vc1' }, ctx(false));
    expect(refused?.isError).toBe(true);
    const ok = await join?.execute({ channelId: 'vc1' }, ctx(true));
    expect(ok?.content[0]).toMatchObject({ text: 'joined vc1 from cvn-1' });
  });
});

describe('transcription service', () => {
  it('is absent without configuration', () => {
    expect(createTranscriber({})).toBeUndefined();
    expect(createTranscriber({ TRANSCRIPTION_BASE_URL: 'https://x/v1' })).toBeUndefined();
  });

  it('posts a WAV to /audio/transcriptions with the configured model', async () => {
    let seen: { url: string; auth: string | null; model: unknown; type: string } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      seen = { url: String(input), auth: new Headers(init?.headers).get('authorization'), model: form.get('model'), type: file.type };
      return Response.json({ text: ' hello ' });
    };
    const transcriber = createTranscriber({ TRANSCRIPTION_BASE_URL: 'https://x/v1/', TRANSCRIPTION_API_KEY: 'k', TRANSCRIPTION_MODEL: 'gpt-4o-transcribe' }, fetchFn);
    expect(await transcriber?.transcribe(pcm16ToWav(Buffer.alloc(320), 16_000))).toBe('hello');
    expect(seen).toEqual({ url: 'https://x/v1/audio/transcriptions', auth: 'Bearer k', model: 'gpt-4o-transcribe', type: 'audio/wav' });
  });
});
