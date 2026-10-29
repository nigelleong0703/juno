/** agent-meet invocation and strict parsing of its output. */
import { describe, expect, it } from 'vitest';
import { MEET_HELPER, meetCommand, parseMeetOutput } from './meet.js';
import { BrowserDownError } from './errors.js';
import { screenPorts } from './ports.js';
import { rootDir, shq } from './screen-boot.js';

describe('meet helper invocation', () => {
  it('passes the display CDP port, the display number and a quoted request, with the display cookie', () => {
    const input = { action: 'join', url: 'https://meet.google.com/abc-defg-hij', name: "O'Neil" } as const;
    const command = meetCommand(3, input);
    expect(command).toContain(`${MEET_HELPER} --port ${screenPorts(3).cdp} --display 3 --request ${shq(JSON.stringify(input))}`);
    expect(command).toContain(`${rootDir(3)}/xauth`);
  });
});

describe('meet helper output', () => {
  it('parses each action result', () => {
    expect(parseMeetOutput(JSON.stringify({ ok: true, action: 'join', state: 'waiting_admission', detail: 'd' }), '', 0, 'join')).toEqual({ action: 'join', state: 'waiting_admission', detail: 'd' });
    const chat = parseMeetOutput(JSON.stringify({ ok: true, action: 'chat_read', messages: [{ id: 'a', sender: 'S', text: 't' }] }), '', 0, 'chat_read');
    expect(chat).toMatchObject({ action: 'chat_read', messages: [{ id: 'a' }] });
    const audio = parseMeetOutput(JSON.stringify({ ok: true, action: 'audio_read', on: true, epoch: 'e1', segments: [{ seq: 1, start: '2026-10-21T10:00:00.000Z', end: '2026-10-21T10:00:05.000Z', speakers: ['Ann'], data: 'AAAA' }] }), '', 0, 'audio_read');
    expect(audio).toMatchObject({ action: 'audio_read', on: true, segments: [{ seq: 1, speakers: ['Ann'] }] });
  });

  it('fails truthfully on helper errors, bad JSON, wrong action and a missing Chromium', () => {
    expect(() => parseMeetOutput(JSON.stringify({ ok: false, error: 'no Meet tab' }), '', 1, 'state')).toThrow(/no Meet tab/);
    expect(() => parseMeetOutput('nope', '', 0, 'state')).toThrow(/invalid JSON/);
    expect(() => parseMeetOutput(JSON.stringify({ ok: true, action: 'leave', state: 'ended', detail: 'x' }), '', 0, 'state')).toThrow(/leave result/);
    expect(() => parseMeetOutput(JSON.stringify({ ok: true, action: 'state', state: 'bogus', detail: 'x' }), '', 0, 'state')).toThrow(/unexpected result/);
    expect(() => parseMeetOutput(JSON.stringify({ ok: false, error: `no CDP on 127.0.0.1:${screenPorts(2).cdp} (refused)` }), '', 1, 'state')).toThrow(BrowserDownError);
    expect(() => parseMeetOutput('', 'agent-meet: not found', 127, 'state')).toThrow(/installed in this image/);
  });
});
