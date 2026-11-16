import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { forceClose } from '../boot.js';

describe('forceClose', () => {
  it('cuts a request still in flight instead of throwing (every slow stop used to crash the API)', async () => {
    const server = createServer(() => { /* never answers */ });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const cut = new Promise<string>((done) => {
      const req = request({ port, host: '127.0.0.1', path: '/' });
      req.on('error', (error) => done(error.message));
      req.end();
    });
    await new Promise((done) => setTimeout(done, 50));
    const closed = new Promise<void>((done) => server.close(() => done()));
    expect(() => forceClose(server)).not.toThrow();
    await closed;
    expect(await cut).toMatch(/socket hang up|ECONNRESET/);
  });
});
