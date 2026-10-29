import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { LinkHub } from '@agent-desktop/sandbox-adapters';
import { createLinkServer } from './link-endpoint.js';

describe('link server', () => {
  it('reports a taken port to the caller of listen without an unhandled error from the websocket server', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '0.0.0.0', resolve));
    const port = (holder.address() as { port: number }).port;
    const server = createLinkServer({ accept: () => undefined } as unknown as LinkHub);
    try {
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        server.once('error', resolve);
        server.listen(port, '0.0.0.0');
      });
      expect(error.code).toBe('EADDRINUSE');
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
