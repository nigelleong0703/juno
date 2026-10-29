import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer } from '@agent-desktop/contracts';
import { createComputerdClient } from '../../computerd.js';
import { createPluginHost } from '../../plugins/host.js';
import type { Services } from '../../plugins/services.js';
import { meetingsPlugin } from '../plugin.js';

const enqueuer: Enqueuer = { async enqueue() { return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {}, async scheduleRoutine() {} };
const computerd = createComputerdClient({ baseUrl: 'http://computerd.invalid', token: 't', fetch: async () => { throw new Error('offline'); } });
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function loaded(computer: Services['computer']) {
  const host = createPluginHost<Services>({ log: quiet });
  host.provide('store', createMemoryStore());
  host.provide('enqueuer', enqueuer);
  host.provide('computerd', computerd);
  host.provide('computer', computer);
  host.use(meetingsPlugin);
  await host.load();
  return host;
}

describe('meetings plugin', () => {
  it('registers the four meeting tools, offered only to an agent that can attend, and removes them when disabled', async () => {
    const host = await loaded(undefined);
    expect(host.status()).toEqual([{ name: 'meetings', state: 'active' }]);
    expect(host.tools().map((t) => t.tool.name)).toEqual(['meeting_join', 'meeting_leave', 'meeting_say', 'meeting_transcript']);
    // No computer and no Feishu channel for this agent: the tools stay registered but are not offered.
    expect(await host.tools()[0]?.visibleFor?.('agent-1')).toBe(false);
    await host.disable('meetings');
    expect(host.tools()).toEqual([]);
  });
});
