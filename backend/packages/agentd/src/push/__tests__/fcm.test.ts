/**
 * FCM sender, offline: service-account JWT and its exchange against a throwaway RSA key, access-token caching,
 * message shape, dead-token answers, and transient failures. `fetch` is a fake; no socket is opened.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify } from 'crypto';
import { createFcmSender, fcmConfigFromEnv, signServiceAccountAssertion, type FcmPayload } from '../fcm.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'fcm_Token-1:' + 'A'.repeat(120);
const PAYLOAD: FcmPayload = { title: 'Mira needs you', body: 'Send the email', data: { conversationId: 'conv-1', requestId: 'req-1' } };
const TOKEN_URI = 'https://oauth2.example.test/token';
const config = { projectId: 'juno-test', clientEmail: 'push@juno-test.iam.gserviceaccount.com', privateKeyPem: PEM, tokenUri: TOKEN_URI };

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('FCM service account', () => {
  it('signs an RS256 assertion with iss, scope, aud, iat and exp', () => {
    const jwt = signServiceAccountAssertion({ clientEmail: config.clientEmail, tokenUri: TOKEN_URI, key: privateKey, issuedAtSeconds: 1700000000 });
    const [header, claims, signature] = jwt.split('.');
    expect(decodeSegment(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(claims!)).toEqual({
      iss: config.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: TOKEN_URI,
      iat: 1700000000,
      exp: 1700003600,
    });
    expect(verify('RSA-SHA256', Buffer.from(header + '.' + claims), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('reads the service account JSON from env, and stays null when unset', () => {
    expect(fcmConfigFromEnv({})).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: '  ' })).toBeNull();
    const json = JSON.stringify({ project_id: 'juno-test', client_email: config.clientEmail, private_key: PEM, token_uri: TOKEN_URI });
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: json })).toEqual(config);
    expect(() => fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: '{"project_id":"x"}' })).toThrow();
  });
});

describe('FCM sender', () => {
  /** Answers the token exchange, then each queued send response in turn. */
  function fakeFetch(sends: Array<{ status: number; body?: string }>, expiresIn = 3600) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let exchanges = 0;
    const impl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, body: String(init?.body) });
      if (url === TOKEN_URI) {
        exchanges += 1;
        return Response.json({ access_token: 'ya29.token-' + String(exchanges), expires_in: expiresIn });
      }
      const next = sends.shift() ?? { status: 200 };
      return new Response(next.body ?? '{}', { status: next.status });
    };
    return { calls, impl, exchanges: () => exchanges };
  }

  it('exchanges the signed JWT once, reuses the access token, and refreshes it before it expires', async () => {
    const { calls, impl, exchanges } = fakeFetch([{ status: 200 }, { status: 200 }, { status: 200 }]);
    let now = 1_700_000_000_000;
    const sender = createFcmSender({ config, fetch: impl, now: () => now });
    await expect(sender.send({ token: TOKEN }, PAYLOAD)).resolves.toBe('sent');
    await expect(sender.send({ token: TOKEN }, PAYLOAD)).resolves.toBe('sent');
    expect(exchanges()).toBe(1);

    const exchange = calls[0]!;
    expect(exchange.url).toBe(TOKEN_URI);
    expect(exchange.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(exchange.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(decodeSegment(form.get('assertion')!.split('.')[1]!)).toMatchObject({ iss: config.clientEmail, aud: TOKEN_URI, iat: 1_700_000_000 });

    now += 56 * 60 * 1000; // inside the 5 minute refresh margin of a 1 hour token
    await expect(sender.send({ token: TOKEN }, PAYLOAD)).resolves.toBe('sent');
    expect(exchanges()).toBe(2);
    expect(calls.at(-1)!.headers['authorization']).toBe('Bearer ya29.token-2');
  });

  it('shares one exchange between concurrent sends', async () => {
    const { impl, exchanges } = fakeFetch([]);
    const sender = createFcmSender({ config, fetch: impl });
    await Promise.all([sender.send({ token: TOKEN }, PAYLOAD), sender.send({ token: TOKEN }, PAYLOAD)]);
    expect(exchanges()).toBe(1);
  });

  it('posts a high-priority message with the notification and string data to the project endpoint', async () => {
    const { calls, impl } = fakeFetch([{ status: 200 }]);
    const sender = createFcmSender({ config, fetch: impl });
    await sender.send({ token: TOKEN }, PAYLOAD);
    const send = calls[1]!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/juno-test/messages:send');
    expect(send.headers['authorization']).toBe('Bearer ya29.token-1');
    expect(JSON.parse(send.body)).toEqual({
      message: {
        token: TOKEN,
        notification: { title: 'Mira needs you', body: 'Send the email' },
        data: { conversationId: 'conv-1', requestId: 'req-1' },
        android: { priority: 'HIGH', notification: { sound: 'default' } },
      },
    });
  });

  it('reports 404, UNREGISTERED and an INVALID_ARGUMENT about the token as dead; other rejections as failed', async () => {
    const tokenInvalid = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.token' }] }] } });
    const payloadInvalid = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.data' }] }] } });
    const { impl } = fakeFetch([
      { status: 404, body: '{"error":{"status":"NOT_FOUND"}}' },
      { status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' },
      { status: 400, body: tokenInvalid },
      { status: 400, body: payloadInvalid },
      { status: 403, body: '{"error":{"status":"SENDER_ID_MISMATCH"}}' },
    ]);
    const errors: string[] = [];
    const sender = createFcmSender({ config, fetch: impl, onError: (message) => errors.push(message) });
    const target = { token: TOKEN };
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('invalid_token');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('invalid_token');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('invalid_token');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    expect(errors).toHaveLength(2);
  });

  it('treats 429 and 5xx as a failed send (no retry, as APNs), and 401 drops the cached access token', async () => {
    const { calls, impl, exchanges } = fakeFetch([{ status: 429 }, { status: 503 }, { status: 401 }, { status: 200 }]);
    const sender = createFcmSender({ config, fetch: impl, onError: () => undefined });
    const target = { token: TOKEN };
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    expect(exchanges()).toBe(1);
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('sent');
    expect(exchanges()).toBe(2);
    expect(calls.filter((c) => c.url !== TOKEN_URI)).toHaveLength(4);
  });

  it('treats a failed token exchange or a network error as a failed send, not a dead token', async () => {
    const errors: string[] = [];
    const refused = createFcmSender({ config, fetch: async () => new Response('{}', { status: 400 }), onError: (message) => errors.push(message) });
    await expect(refused.send({ token: TOKEN }, PAYLOAD)).resolves.toBe('failed');
    const down = createFcmSender({ config, fetch: async () => { throw new Error('socket reset'); }, onError: (message) => errors.push(message) });
    await expect(down.send({ token: TOKEN }, PAYLOAD)).resolves.toBe('failed');
    expect(errors).toEqual(['FCM request failed', 'FCM request failed']);
  });
});
