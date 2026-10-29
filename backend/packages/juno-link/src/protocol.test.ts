import { describe, expect, it } from 'vitest';
import { Credit, FrameType, MAX_FRAME, ProtocolError, chunks, decodeFrame, encodeFrame, isDesktopAction, jsonFrame, parseDeviceDeclaration, parseJson, readWindow, streamPortAllowed, windowFrame } from './protocol.js';

describe('device declaration', () => {
  const valid = { deviceId: 'dev-1', name: ' Robin MacBook ', osVersion: 'macOS 15.2', actions: ['shell', 'files', 'files', 'desktop'] };

  it('accepts a declaration, orders and de-duplicates its actions, and trims the name', () => {
    expect(parseDeviceDeclaration(valid)).toEqual({ deviceId: 'dev-1', name: 'Robin MacBook', osVersion: 'macOS 15.2', actions: ['files', 'shell', 'desktop'] });
    expect(parseDeviceDeclaration({ ...valid, actions: [] })?.actions).toEqual([]);
  });

  it('refuses the whole declaration for an unknown action, a bad id, empty text or a wrong shape', () => {
    for (const bad of [
      { ...valid, actions: ['files', 'teleport'] },
      // The old coordinate-era actions are gone, not translated.
      { ...valid, actions: ['screen', 'input'] },
      { ...valid, actions: 'files' },
      { ...valid, deviceId: 'has space' },
      { ...valid, deviceId: undefined },
      { ...valid, name: '  ' },
      { ...valid, osVersion: 'x'.repeat(81) },
      null,
      'files',
      [],
    ]) expect(parseDeviceDeclaration(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('frames', () => {
  it('round-trips type, channel and payload', () => {
    const frame = decodeFrame(encodeFrame(FrameType.DATA, 0xfffffffe, new Uint8Array([1, 2, 3])));
    expect(frame).toMatchObject({ type: FrameType.DATA, channel: 0xfffffffe });
    expect([...frame.payload]).toEqual([1, 2, 3]);
    expect(parseJson(decodeFrame(jsonFrame(FrameType.RPC, 7, { method: 'health' })).payload)).toEqual({ method: 'health' });
    expect(readWindow(decodeFrame(windowFrame(3, 4096)).payload)).toBe(4096);
  });

  it('rejects short, oversize and unknown frames', () => {
    expect(() => decodeFrame(new Uint8Array(3))).toThrow(ProtocolError);
    expect(() => decodeFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow(/unknown frame type/);
    expect(() => encodeFrame(FrameType.DATA, 1, new Uint8Array(MAX_FRAME))).toThrow(/exceeds/);
    expect(() => decodeFrame(new Uint8Array(MAX_FRAME + 1))).toThrow(/too large/);
  });

  it('splits data into bounded pieces', () => {
    expect([...chunks(new Uint8Array(10), 4)].map((piece) => piece.length)).toEqual([4, 4, 2]);
  });
});

describe('stream port whitelist', () => {
  it('allows VNC, websockify and the Spaces gateway on loopback ports only', () => {
    for (const port of [5901, 5908, 5991, 6081, 6098, 7090]) expect(streamPortAllowed(port), String(port)).toBe(true);
  });

  it('refuses Chromium CDP, SSH, app ports and everything else', () => {
    for (const port of [22, 5900, 5909, 6080, 6099, 7100, 7091, 9223, 9230, 8791, 0, -1, 5901.5]) expect(streamPortAllowed(port), String(port)).toBe(false);
  });
});

describe('credit', () => {
  it('makes a taker wait until credit is given and wakes everyone on close', async () => {
    const credit = new Credit(10);
    expect(await credit.take(4)).toBe(4);
    expect(await credit.take(100)).toBe(6);
    let got = -1;
    const waiting = credit.take(5).then((n) => (got = n));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(got).toBe(-1);
    credit.give(3);
    await waiting;
    expect(got).toBe(3);
    const closed = credit.take(1);
    credit.close();
    expect(await closed).toBe(0);
  });
});

describe('desktop actions', () => {
  it('accepts the cua actions and mac_apps, refuses unknown actions and the old coordinate ones', () => {
    for (const action of ['snapshot', 'act', 'verify', 'mac_apps']) expect(isDesktopAction(action)).toBe(true);
    for (const old of ['screenshot', 'click', 'double-click', 'right-click', 'move', 'type', 'key', 'scroll', 'control']) expect(isDesktopAction(old), old).toBe(false);
    expect(isDesktopAction('shell')).toBe(false);
  });
});
