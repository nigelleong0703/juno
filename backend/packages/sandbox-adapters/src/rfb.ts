/**
 * Minimal RFB (VNC) security handshake, enough for the server-side proxy (BACKEND §7.2).
 *
 * The proxy is a man in the middle for one handshake only:
 *  - toward the client it presents "None" (the websocket ticket already authenticated it);
 *  - toward x11vnc it answers the VNC-auth challenge with the server-held password.
 * After both handshakes the raw RFB stream is symmetric, so the caller detaches these readers and
 * pipes bytes; the password never appears on the client's wire.
 *
 * Implemented over a narrow channel interface so it is unit-testable without a websocket.
 */
import { vncResponse } from './des.js';

export interface RfbChannel {
  send(data: Buffer): void;
  /** Register a message handler; returns an unsubscribe. */
  onMessage(handler: (data: Buffer) => void): () => void;
  /** Register a close/error handler; returns an unsubscribe. */
  onClose(handler: (error?: Error) => void): () => void;
}

const VERSION = Buffer.from('RFB 003.008\n', 'ascii');
const SECURITY_VNC_AUTH = 2;
const SECURITY_NONE = 1;

/** Pull-based byte reader over a channel's messages. */
class ChunkReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private waiters: Array<() => void> = [];
  private failure: Error | null = null;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    for (const wake of this.waiters.splice(0)) wake();
  }

  fail(error: Error): void {
    this.failure = error;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async read(count: number): Promise<Buffer> {
    while (this.length < count) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const buffer = Buffer.concat(this.chunks, this.length);
    const result = buffer.subarray(0, count);
    const rest = buffer.subarray(count);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return result;
  }

  drain(): Buffer {
    const buffer = Buffer.concat(this.chunks, this.length);
    this.chunks = [];
    this.length = 0;
    return buffer;
  }
}

export interface Detached {
  leftover: Buffer;
  release(): void;
}

export class RfbHandshake {
  private readonly reader = new ChunkReader();
  private readonly offMessage: () => void;
  private readonly offClose: () => void;

  constructor(private readonly channel: RfbChannel) {
    this.offMessage = channel.onMessage((data) => this.reader.push(data));
    this.offClose = channel.onClose((error) => this.reader.fail(error ?? new Error('socket closed')));
  }

  /** Handshake as the server: accept the client, then report the negotiated version. */
  async acceptClient(): Promise<string> {
    this.channel.send(VERSION);
    const version = (await this.reader.read(12)).toString('ascii');
    if (version.startsWith('RFB 003.003')) {
      // 3.3 has no security-type list; the server names the single type.
      this.channel.send(uint32(SECURITY_NONE));
    } else {
      this.channel.send(Buffer.from([1, SECURITY_NONE]));
      const chosen = (await this.reader.read(1)).readUInt8(0);
      if (chosen !== SECURITY_NONE) throw new Error(`client chose unsupported security type ${chosen}`);
    }
    this.channel.send(uint32(0));
    return version;
  }

  /** Handshake as a client: perform VNC authentication against the upstream server. */
  async authenticate(password: string): Promise<void> {
    this.channel.send(VERSION);
    const version = (await this.reader.read(12)).toString('ascii');
    const type = version.startsWith('RFB 003.003') ? await this.readLegacyType() : await this.readOfferedType();
    if (type !== SECURITY_VNC_AUTH) throw new Error(`upstream does not offer VNC authentication (got ${type})`);
    const challenge = await this.reader.read(16);
    this.channel.send(vncResponse(password, challenge));
    const result = (await this.reader.read(4)).readUInt32BE(0);
    if (result !== 0) throw new Error('VNC authentication failed');
  }

  private async readLegacyType(): Promise<number> {
    return (await this.reader.read(4)).readUInt32BE(0);
  }

  private async readOfferedType(): Promise<number> {
    const count = (await this.reader.read(1)).readUInt8(0);
    if (count === 0) {
      const reasonLength = (await this.reader.read(4)).readUInt32BE(0);
      const reason = reasonLength > 0 ? (await this.reader.read(reasonLength)).toString('utf8') : '';
      throw new Error(`upstream refused the connection: ${reason}`);
    }
    const types = await this.reader.read(count);
    const chosen = [...types].find((type) => type === SECURITY_VNC_AUTH);
    if (chosen === undefined) throw new Error('upstream offers no VNC authentication');
    this.channel.send(Buffer.from([chosen]));
    return chosen;
  }

  /** Stop parsing and hand any unconsumed bytes to the raw pipe. */
  detach(): Detached {
    this.offMessage();
    this.offClose();
    return { leftover: this.reader.drain(), release: () => undefined };
  }
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

