import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, diagnose, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * A Web & video app with a real model on a real local computer (`E2E_COMPUTER_PROVIDER=local`, needs the rebuilt `juno-desktop:local` and
 * the internet): the owner adds "YouTube videos", the agent is asked to summarise a public video from its subtitles. It must read the app's
 * skill and run `agent-reach youtube subtitle` in the computer's shell. Assertions are on tool calls, never wording.
 */
describe('real model: YouTube videos app', () => {
  it('reads the app skill and fetches the subtitles with agent-reach to summarise a video', async () => {
    const account = await createAccount('real-web-video');
    const events = await listenEvents(account.cookie);
    try {
      expect((await account.api('POST', '/v1/apps/youtube-videos/install', {})).status).toBe(201);
      const agent = await account.api('POST', '/v1/agents', { name: 'Reader' });
      expect(agent.status).toBe(201);
      expect((await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id })).status).toBeLessThan(300);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text: 'Summarise this YouTube video from what is said in it: https://www.youtube.com/watch?v=jNQXAC9IVRw',
      }));
      expect(sent.status).toBe(202);
      const sessionKey = `${agent.body.id}:${conversationId}`;
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 150_000).catch(async (error: unknown) => {
        await diagnose('web-video', account, conversationId, sessionKey);
        throw error;
      });
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');

      // E2E_VERBOSE=1 prints the chat, the tool calls and their results, to read the answer by eye.
      if (process.env['E2E_VERBOSE'] === '1') await diagnose('web-video', account, conversationId, sessionKey);
      const activity = await toolActivity(`${agent.body.id}:${conversationId}`);
      const calls = JSON.stringify(activity.calls);
      expect(calls, JSON.stringify(activity)).toContain('youtube-videos/agent-reach');
      expect(calls, JSON.stringify(activity)).toMatch(/agent-reach youtube subtitle/);
      const subtitle = activity.results.find((result) => result.text.includes('"backend": "yt-dlp"') || result.text.includes('"backend":"yt-dlp"'));
      expect(subtitle?.isError, JSON.stringify(activity)).toBe(false);
    } finally {
      events.close();
    }
  }, 400_000);
});
