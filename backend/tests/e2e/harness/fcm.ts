import { createServer, type Server } from 'node:http';

/**
 * A stand-in for Firebase Cloud Messaging on the port the stack's FCM_API_BASE_URL names (stack.ts): the OAuth token host of the stack's test
 * service account (`POST /token`) and `POST /v1/projects/<project>/messages:send`. A scenario makes the next sends fail (`failures`, one entry per call);
 * every send is recorded with the device token and the notification, failed or not.
 */
export class FakeFcm {
  /** How the next sends fail (HTTP status and optional body); once empty, sends succeed. */
  readonly failures: Array<{ status: number; body?: Record<string, unknown> }> = [];
  readonly sends: Array<{ token: string; title: string; body: string; status: number }> = [];
  private server: Server | undefined;

  async listen(port: number): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url === '/token') return json(200, { access_token: 'e2e-fcm-token', expires_in: 3600 });
        if (req.url?.endsWith('/messages:send') === true) {
          const message = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message: { token: string; notification: { title: string; body: string } } }).message;
          const failure = this.failures.shift();
          this.sends.push({ token: message.token, title: message.notification.title, body: message.notification.body, status: failure?.status ?? 200 });
          return json(failure?.status ?? 200, failure?.body ?? { name: 'projects/e2e-project/messages/1' });
        }
        return json(404, {});
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
  }
}
