import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../../testing/store.js';
import { createBlockStreamer, countStreamed, postStreamedBubble, reconcileStreamed } from '../block-stream.js';
import { MAX_REPLY_BUBBLES, readingPauseMs } from '../reply-layout.js';
import type { RunInput, RunServices } from '../run-types.js';

/** A streamer on a fake clock: `wait` advances the clock, `advance` is the model writing for a while. */
function harness(options: { cancelled?: () => boolean; failAt?: number } = {}) {
  let clock = 1000;
  const posts: Array<{ index: number; markdown: string; at: number }> = [];
  const streamer = createBlockStreamer({
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    post: async (index, markdown) => {
      if (index === options.failAt) throw new Error('store down');
      posts.push({ index, markdown, at: clock });
    },
    isCancelled: options.cancelled ?? (() => false),
  });
  return { streamer, posts, advance: (ms: number) => { clock += ms; } };
}
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('createBlockStreamer', () => {
  it('posts the first closed paragraph at once, while the rest is still being written', async () => {
    const { streamer, posts } = harness();
    for (const chunk of ['First par', 'agraph.\n', '\nSecond one is still being wr']) streamer.push(chunk);
    await settle();
    expect(posts.map((post) => post.markdown)).toEqual(['First paragraph.']);
  });

  it('never posts two blocks together: a block waits for the previous post plus its own reading pause', async () => {
    const { streamer, posts } = harness();
    streamer.push('One.\n\nTwo two.\n\nThree.\n\nTail');
    await settle();
    await settle();
    await settle();
    expect(posts.map((post) => post.markdown)).toEqual(['One.', 'Two two.', 'Three.']);
    expect(posts[1]!.at - posts[0]!.at).toBe(readingPauseMs('Two two.'));
    expect(posts[2]!.at - posts[1]!.at).toBe(readingPauseMs('Three.'));
  });

  it('counts the time the model spent writing toward the pause', async () => {
    const { streamer, posts, advance } = harness();
    streamer.push('One.\n\nTw');
    await settle();
    advance(5000);
    streamer.push('o.\n\nTail');
    await settle();
    // The model took longer than the pause: Two. goes out the moment it is closed, no extra wait.
    expect(posts.map((post) => [post.markdown, post.at])).toEqual([['One.', 1000], ['Two.', 6000]]);
  });

  it('releases at most the cap minus one blocks; the rest is left for the final bubble', async () => {
    const { streamer, posts } = harness();
    streamer.push(Array.from({ length: 10 }, (_, i) => `Line ${i}.`).join('\n\n') + '\n\n');
    for (let i = 0; i < 12; i += 1) await settle();
    expect(posts).toHaveLength(MAX_REPLY_BUBBLES - 1);
  });

  it('drops blocks still waiting when the model is done (the final reply posts them)', async () => {
    const { streamer, posts } = harness();
    streamer.push('One.\n\nTwo.\n\nThree.\n\nTail');
    await streamer.finish();
    expect(posts.map((post) => post.index)).toEqual([0]);
    streamer.push('\n\nMore.\n\n');
    await streamer.finish();
    expect(posts).toHaveLength(1);
  });

  it('posts nothing more once the run is cancelled; blocks already posted stay', async () => {
    let cancelled = false;
    const { streamer, posts } = harness({ cancelled: () => cancelled });
    streamer.push('One.\n\nTail');
    await settle();
    cancelled = true;
    streamer.push('\n\nTwo.\n\nThree.\n\nTail');
    await settle();
    await settle();
    expect(posts.map((post) => post.markdown)).toEqual(['One.']);
  });

  it('stops streaming after a failed post instead of failing the turn', async () => {
    const { streamer, posts } = harness({ failAt: 1 });
    streamer.push('One.\n\nTwo.\n\nThree.\n\nTail');
    await streamer.finish();
    await settle();
    expect(posts.map((post) => post.index)).toEqual([0]);
  });
});

describe('streamed bubbles in the store', () => {
  const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [] };
  const setup = () => {
    const store = createMemoryStore();
    const logs: string[] = [];
    const services = { store, log: (_fields: unknown, message: string) => logs.push(message) } as unknown as RunServices;
    const texts = async () => (await store.list('items', { where: { conversationId: 'c' }, orderBy: 'at', limit: 20 })).items.flatMap((item) => (item.type === 'agent_message' ? [item.markdown] : []));
    return { store, services, logs, texts };
  };

  it('writes by a deterministic id, so a retried step overwrites instead of duplicating', async () => {
    const { services, store, texts } = setup();
    const events: unknown[] = [];
    const original = store.emit.bind(store);
    store.emit = async (event) => { events.push(event); await original(event); };
    await postStreamedBubble(services, input, 'run-1', 2, 0, 'Hello.');
    const first = events.length;
    await postStreamedBubble(services, input, 'run-1', 2, 0, 'Hello.');
    expect(events.length).toBe(first);
    await postStreamedBubble(services, input, 'run-1', 2, 0, 'Hello again.');
    expect(await texts()).toEqual(['Hello again.']);
    expect(await countStreamed(services, 'run-1', 2)).toBe(1);
  });

  it('reconcile: same text changes nothing, different text is rewritten, extra bubbles are deleted', async () => {
    const { services, store, texts, logs } = setup();
    await postStreamedBubble(services, input, 'run-1', 0, 0, 'A.');
    await postStreamedBubble(services, input, 'run-1', 0, 1, 'B.');
    await postStreamedBubble(services, input, 'run-1', 0, 2, 'C.');
    let events = 0;
    const original = store.emit.bind(store);
    store.emit = async (event) => { events += 1; await original(event); };
    expect(await reconcileStreamed(services, input, 'run-1', 0, [{ markdown: 'A.' }, { markdown: 'B.' }, { markdown: 'C.' }], [])).toMatchObject({ existing: 3 });
    expect(events).toBe(0);
    expect(logs).toEqual([]);
    expect(await reconcileStreamed(services, input, 'run-1', 0, [{ markdown: 'A.' }, { markdown: 'B and more.' }], [])).toMatchObject({ existing: 2 });
    expect(await texts()).toEqual(['A.', 'B and more.']);
    expect(events).toBeGreaterThan(0);
    expect(logs).toEqual(['streamed bubble rewritten after the final layout', 'streamed bubble removed: the final layout has fewer bubbles']);
  });

  it('reconcile puts the sources on the last bubble', async () => {
    const { services, store } = setup();
    await postStreamedBubble(services, input, 'run-1', 0, 0, 'A.');
    await reconcileStreamed(services, input, 'run-1', 0, [{ markdown: 'A.' }], [{ id: 'w1', title: 'T', url: 'https://x.test' }]);
    const item = await store.get('items', 'itm_run-1_0_0');
    expect(item?.type === 'agent_message' ? item.citations : []).toHaveLength(1);
  });
});
