import { describe, expect, it } from 'vitest';
import type { ChannelRow } from '@agent-desktop/contracts';
import { LONG_RESULT_CHARS, createSlackSender, sendSlackRich } from '../slack/send.js';
import { setSlackThreadStatus } from '../slack/status.js';

const channel = { id: 'slack:x', botToken: 'xoxb-1' } as ChannelRow;
const target = { channel, chatId: 'C1', threadId: 'C1:5.5' };
const long = { text: '# Report\n' + 'word '.repeat(LONG_RESULT_CHARS / 4), buttons: [], questions: [], ownerOnly: false };

function slack(answers: Record<string, Record<string, unknown>>) {
  const calls: Array<{ method: string; body: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = url.split('/api/')[1] ?? url;
    calls.push({ method, body: typeof init?.body === 'string' ? init.body : '' });
    return Response.json(answers[method] ?? { ok: true, ts: '9.9' });
  };
  return { calls, fetchFn };
}

describe('a long Slack result', () => {
  it('goes out as a canvas of the channel with a short note in the thread', async () => {
    const { calls, fetchFn } = slack({ 'canvases.create': { ok: true, canvas_id: 'F1' } });
    expect(await sendSlackRich(fetchFn, target, long)).toMatchObject({ ok: true });
    expect(calls.map((call) => call.method)).toEqual(['canvases.create', 'chat.postMessage']);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ channel_id: 'C1', title: 'Report' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ thread_ts: '5.5', text: expect.stringContaining('canvas') });
  });

  it('goes out as a file when the workspace does not allow the canvas, and as messages when it does not allow that either', async () => {
    const file = slack({ 'canvases.create': { ok: false, error: 'free_teams_cannot_create_standalone_canvases' }, 'files.getUploadURLExternal': { ok: true, upload_url: 'https://files.slack.com/up', file_id: 'F2' }, 'https://files.slack.com/up': { ok: true }, 'files.completeUploadExternal': { ok: true } });
    expect(await sendSlackRich(file.fetchFn, target, long)).toMatchObject({ ok: true });
    expect(file.calls.map((call) => call.method)).toEqual(['canvases.create', 'files.getUploadURLExternal', 'https://files.slack.com/up', 'files.completeUploadExternal']);
    const none = slack({ 'canvases.create': { ok: false, error: 'canvas_disabled_user_team' }, 'files.getUploadURLExternal': { ok: false, error: 'missing_scope' } });
    expect(await sendSlackRich(none.fetchFn, target, long)).toMatchObject({ ok: true });
    expect(none.calls.filter((call) => call.method === 'chat.postMessage').length).toBeGreaterThanOrEqual(1);
  });

  it('a short reply, or one with buttons, is an ordinary message', async () => {
    const { calls, fetchFn } = slack({});
    await sendSlackRich(fetchFn, target, { text: 'short', buttons: [], questions: [], ownerOnly: false });
    await sendSlackRich(fetchFn, target, { ...long, buttons: [{ id: 'jn:approval:r:0', label: 'Approve', value: 'Approve', style: 'primary' }] });
    expect(calls.some((call) => call.method === 'canvases.create')).toBe(false);
  });
});

describe('Slack assistant status and the owner\'s private chat', () => {
  it('sets and clears the status of an assistant thread', async () => {
    const { calls, fetchFn } = slack({});
    await setSlackThreadStatus(fetchFn, 'xoxb-1', 'D1', '7.7', 'is thinking…');
    await setSlackThreadStatus(fetchFn, 'xoxb-1', 'D1', '7.7', '');
    expect(calls.map((call) => JSON.parse(call.body))).toEqual([{ channel_id: 'D1', thread_ts: '7.7', status: 'is thinking…' }, { channel_id: 'D1', thread_ts: '7.7', status: '' }]);
  });

  it('opens the direct chat with a person (conversations.open) and answers its id', async () => {
    const { calls, fetchFn } = slack({ 'conversations.open': { ok: true, channel: { id: 'D9' } } });
    expect(await createSlackSender(fetchFn).openDirect?.('xoxb-1', 'U1')).toBe('D9');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ users: 'U1' });
  });
});
