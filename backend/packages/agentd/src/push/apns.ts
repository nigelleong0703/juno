/**
 * APNs sender (token-based auth): an ES256 provider JWT signed with the team's .p8 key, posted over
 * HTTP/2 to the host matching the device's registration environment. The transport is injectable so
 * tests never open a socket. Tokens that APNs reports as dead are reported back as `invalid_token`.
 */
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'crypto';
import { readFileSync } from 'fs';
import { connect, constants as h2, type ClientHttp2Session } from 'node:http2';

export type ApnsEnvironment = 'sandbox' | 'production';
export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
  topic: string;
}

export interface ApnsPayload {
  aps: { alert: { title: string; body: string }; sound: string; 'thread-id'?: string };
  [key: string]: unknown;
}

export interface ApnsTarget {
  token: string;
  environment: ApnsEnvironment;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

/** One POST to `https://<host><path>`. The default implementation is HTTP/2; tests inject their own. */
export type ApnsTransport = (
  host: string,
  path: string,
  headers: Record<string, string>,
  body: string,
) => Promise<ApnsResponse>;

export interface PushSender {
  send(target: ApnsTarget, payload: ApnsPayload): Promise<PushOutcome>;
}

const DEFAULT_TOPIC = 'io.github.nigelleong0703.juno';
/** APNs accepts a provider token for up to an hour; refresh well before that. */
const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
};

/**
 * Reads the APNs settings from the environment. Returns null when the key id, team id or key is missing:
 * the caller then runs with push disabled. `APNS_KEY` may carry the PEM with literal `\n` escapes.
 */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv): ApnsConfig | null {
  const keyId = env['APNS_KEY_ID']?.trim();
  const teamId = env['APNS_TEAM_ID']?.trim();
  const inline = env['APNS_KEY'];
  const path = env['APNS_KEY_PATH']?.trim();
  if (!keyId || !teamId) return null;
  let pem: string | null = null;
  if (inline && inline.trim().length > 0) pem = inline.replace(/\\n/g, '\n').trim() + '\n';
  else if (path) pem = readFileSync(path, 'utf8');
  if (!pem) return null;
  return { keyId, teamId, privateKeyPem: pem, topic: env['APNS_TOPIC']?.trim() || DEFAULT_TOPIC };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** ES256 provider token: header {alg, kid}, claims {iss, iat}; the signature is raw r||s (APNs rejects DER). */
export function signProviderToken(args: { keyId: string; teamId: string; key: KeyObject; issuedAtSeconds: number }): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: args.keyId }));
  const claims = base64url(JSON.stringify({ iss: args.teamId, iat: args.issuedAtSeconds }));
  const input = header + '.' + claims;
  const signature = cryptoSign('sha256', Buffer.from(input), { key: args.key, dsaEncoding: 'ieee-p1363' });
  return input + '.' + base64url(signature);
}

/** Dead-token answers: 410 (Unregistered) and 400 BadDeviceToken. Anything else is a transient or config failure. */
export function isDeadTokenResponse(response: ApnsResponse): boolean {
  if (response.status === 410) return true;
  if (response.status !== 400) return false;
  try {
    const parsed = JSON.parse(response.body) as { reason?: unknown };
    return parsed.reason === 'BadDeviceToken';
  } catch {
    return false;
  }
}

export function createApnsSender(args: {
  config: ApnsConfig;
  transport?: ApnsTransport;
  now?: () => number;
  onError?: (message: string, detail: Record<string, unknown>) => void;
}): PushSender {
  const key = createPrivateKey(args.config.privateKeyPem);
  const transport = args.transport ?? http2Transport;
  const now = args.now ?? Date.now;
  let cached: { jwt: string; issuedAt: number } | null = null;

  const providerToken = (): string => {
    const current = now();
    if (cached === null || current - cached.issuedAt >= JWT_TTL_MS) {
      const jwt = signProviderToken({
        keyId: args.config.keyId,
        teamId: args.config.teamId,
        key,
        issuedAtSeconds: Math.floor(current / 1000),
      });
      cached = { jwt, issuedAt: current };
    }
    return cached.jwt;
  };

  return {
    async send(target, payload): Promise<PushOutcome> {
      const host = APNS_HOSTS[target.environment];
      try {
        const response = await transport(
          host,
          '/3/device/' + target.token,
          {
            authorization: 'bearer ' + providerToken(),
            'apns-topic': args.config.topic,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
          },
          JSON.stringify(payload),
        );
        if (response.status === 200) return 'sent';
        if (isDeadTokenResponse(response)) return 'invalid_token';
        args.onError?.('APNs rejected push', { status: response.status, body: response.body.slice(0, 200) });
        return 'failed';
      } catch (err) {
        args.onError?.('APNs request failed', { err: err instanceof Error ? err.message : String(err) });
        return 'failed';
      }
    },
  };
}

/** One HTTP/2 session per APNs host, reused; a session that errors or receives GOAWAY is dropped and redialled. */
export const http2Transport: ApnsTransport = (() => {
  const sessions = new Map<string, ClientHttp2Session>();

  const sessionFor = (host: string): ClientHttp2Session => {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect('https://' + host);
    const drop = (): void => {
      if (sessions.get(host) === session) sessions.delete(host);
    };
    session.on('goaway', drop);
    session.on('error', drop);
    session.on('close', drop);
    // Never keep the process alive just for an idle push connection.
    session.unref();
    sessions.set(host, session);
    return session;
  };

  return (host, path, headers, body) =>
    new Promise<ApnsResponse>((resolve, reject) => {
      const req = sessionFor(host).request({
        [h2.HTTP2_HEADER_METHOD]: 'POST',
        [h2.HTTP2_HEADER_PATH]: path,
        ...headers,
      });
      let status = 0;
      let data = '';
      req.setEncoding('utf8');
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(h2.NGHTTP2_CANCEL));
      req.on('response', (h) => {
        status = Number(h[h2.HTTP2_HEADER_STATUS]);
      });
      req.on('data', (chunk: string) => {
        data += chunk;
      });
      req.on('error', reject);
      // A stream that closes without a response (timeout, reset) must settle, not hang the sender.
      req.on('close', () => reject(new Error('APNs stream closed before a response')));
      req.on('end', () => resolve({ status, body: data }));
      req.end(body);
    });
})();
