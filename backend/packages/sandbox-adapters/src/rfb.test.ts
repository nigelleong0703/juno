/**
 * The RFB handshake the proxy runs on both ends. Getting a direction wrong breaks every real
 * stream, so both are pinned here over an in-memory channel: the server side (what the browser
 * sees) and the client side (what x11vnc sees) for both 3.8 and legacy 3.3.
 */
import { describe, expect, it } from 'vitest';
import { RfbHandshake, type RfbChannel } from './rfb.js';
import { vncResponse } from './des.js';

const VERSION = Buffer.from('RFB 003.008\n', 'ascii');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const uint32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
};

class FakeChannel implements RfbChannel {
  readonly sent: Buffer[] = [];
  private readonly messageHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }

  onMessage(handler: (data: Buffer) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  peer(...chunks: Buffer[]): void {
    for (const chunk of chunks) for (const handler of this.messageHandlers) handler(chunk);
  }

  close(error?: Error): void {
    for (const handler of this.closeHandlers) handler(error);
  }
}

describe('RfbHandshake.acceptClient', () => {
  it('offers only None and completes with SecurityResult 0', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.acceptClient();
    await tick();
    expect(channel.sent[0]).toEqual(VERSION);

    channel.peer(VERSION);
    await tick();
    expect(channel.sent[1]).toEqual(Buffer.from([1, 1]));

    channel.peer(Buffer.from([1]));
    await tick();
    expect(channel.sent[2]?.readUInt32BE(0)).toBe(0);
    await expect(done).resolves.toBe('RFB 003.008\n');
  });

  it('rejects a client that selects a security type we do not offer', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.acceptClient();
    await tick();
    channel.peer(VERSION);
    await tick();
    channel.peer(Buffer.from([2]));
    await expect(done).rejects.toThrow(/unsupported security type/);
  });
});

describe('RfbHandshake.authenticate', () => {
  it('answers the challenge with the DES response and accepts the upstream result', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.authenticate('secr3t-pw');
    await tick();
    expect(channel.sent[0]).toEqual(VERSION);

    channel.peer(VERSION);
    await tick();
    // Version and the offered security-type list arrive together, as a real server sends them.
    channel.peer(Buffer.from([1, 2]));
    await tick();
    expect(channel.sent[1]).toEqual(Buffer.from([2]));

    const challenge = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
    channel.peer(challenge);
    await tick();
    expect(channel.sent[2]).toEqual(vncResponse('secr3t-pw', challenge));

    channel.peer(uint32(0));
    await expect(done).resolves.toBeUndefined();
  });

  it('fails when the upstream refuses VNC auth', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.authenticate('pw');
    await tick();
    channel.peer(VERSION);
    await tick();
    // Offered types [1] (None only) -> no VNC auth to choose.
    channel.peer(Buffer.from([1, 1]));
    await expect(done).rejects.toThrow(/no VNC authentication/);
  });

  it('handles legacy 3.3 by reading the single type as uint32', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.authenticate('pw');
    await tick();
    channel.peer(Buffer.from('RFB 003.003\n', 'ascii'));
    await tick();
    channel.peer(uint32(2));
    const challenge = Buffer.alloc(16, 7);
    channel.peer(challenge);
    await tick();
    expect(channel.sent.at(-1)).toEqual(vncResponse('pw', challenge));
    channel.peer(uint32(0));
    await expect(done).resolves.toBeUndefined();
  });
});

describe('RfbHandshake framing', () => {
  it('reassembles a version split across messages', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.acceptClient();
    await tick();
    channel.peer(Buffer.from('RFB 003.'));
    await tick();
    expect(channel.sent).toHaveLength(1); // nothing yet: only part of the version arrived
    channel.peer(Buffer.from('008\n'));
    await tick();
    expect(channel.sent[1]).toEqual(Buffer.from([1, 1]));
    channel.peer(Buffer.from([1]));
    await expect(done).resolves.toBe('RFB 003.008\n');
  });

  it('reads a security-type list delivered in pieces', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.authenticate('pw');
    await tick();
    channel.peer(VERSION);
    await tick();
    channel.peer(Buffer.from([2])); // count only
    await tick();
    expect(channel.sent).toHaveLength(1); // the type bytes are still missing
    channel.peer(Buffer.from([2, 1]));
    await tick();
    expect(channel.sent[1]).toEqual(Buffer.from([2]));
    channel.peer(Buffer.from('00000000000000000000000000000000', 'hex'));
    await tick();
    channel.peer(uint32(0));
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects instead of hanging when the channel closes mid-handshake', async () => {
    const channel = new FakeChannel();
    const handshake = new RfbHandshake(channel);
    const done = handshake.acceptClient();
    await tick();
    channel.close(new Error('socket reset'));
    await expect(done).rejects.toThrow('socket reset');
  });
});
