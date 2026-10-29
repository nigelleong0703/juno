/**
 * FCM sender (HTTP v1): a Google service account signs an RS256 JWT, which is exchanged at the account's
 * `token_uri` for a short-lived OAuth access token (cached until shortly before it expires); messages are
 * posted to `fcm.googleapis.com/v1/projects/<project>/messages:send`. `fetch` is injectable so tests never
 * open a socket. Like the APNs sender there is no retry: a transient failure is `failed`, a token FCM
 * reports as dead is `invalid_token`.
 */
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'crypto';
import { z } from 'zod';
import type { PushOutcome } from './apns.js';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
  tokenUri: string;
}

export interface FcmPayload {
  title: string;
  body: string;
  /** FCM data values must be strings. */
  data: Record<string, string>;
}

export interface FcmSender {
  send(target: { token: string }, payload: FcmPayload): Promise<PushOutcome>;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ASSERTION_TTL_SECONDS = 3600;
/** Refresh the access token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().url().default('https://oauth2.googleapis.com/token'),
});

/**
 * Reads the service account from `FCM_SERVICE_ACCOUNT`, the downloaded key file's JSON on one line.
 * Returns null when unset or empty (Android push is then off); throws when it is set but malformed.
 */
export function fcmConfigFromEnv(env: NodeJS.ProcessEnv): FcmConfig | null {
  const raw = env['FCM_SERVICE_ACCOUNT']?.trim();
  if (!raw) return null;
  const account = serviceAccountSchema.parse(JSON.parse(raw));
  return {
    projectId: account.project_id,
    clientEmail: account.client_email,
    privateKeyPem: account.private_key,
    tokenUri: account.token_uri,
  };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** RS256 assertion for the JWT-bearer grant: claims {iss, scope, aud, iat, exp}. */
export function signServiceAccountAssertion(args: {
  clientEmail: string;
  tokenUri: string;
  key: KeyObject;
  issuedAtSeconds: number;
}): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: args.clientEmail,
      scope: SCOPE,
      aud: args.tokenUri,
      iat: args.issuedAtSeconds,
      exp: args.issuedAtSeconds + ASSERTION_TTL_SECONDS,
    }),
  );
  const input = header + '.' + claims;
  return input + '.' + base64url(cryptoSign('RSA-SHA256', Buffer.from(input), args.key));
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

const errorBodySchema = z.object({
  error: z.object({
    status: z.string().optional(),
    details: z
      .array(
        z.object({
          errorCode: z.string().optional(),
          fieldViolations: z.array(z.object({ field: z.string().optional() })).optional(),
        }),
      )
      .optional(),
  }),
});

/**
 * Dead-token answers: 404, an `UNREGISTERED` error code, or 400 `INVALID_ARGUMENT` that blames the token field
 * (an INVALID_ARGUMENT about the payload is our bug, not a dead device). Anything else is transient or config.
 */
export function isDeadTokenResponse(status: number, body: string): boolean {
  if (status === 404) return true;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  const parsed = errorBodySchema.safeParse(json);
  if (!parsed.success) return false;
  const { status: code, details = [] } = parsed.data.error;
  if (code === 'UNREGISTERED' || details.some((d) => d.errorCode === 'UNREGISTERED')) return true;
  if (status !== 400 || code !== 'INVALID_ARGUMENT') return false;
  return details.some((d) => d.fieldViolations?.some((v) => v.field === 'message.token'));
}

export function createFcmSender(args: {
  config: FcmConfig;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (message: string, detail: Record<string, unknown>) => void;
}): FcmSender {
  const key = createPrivateKey(args.config.privateKeyPem);
  const doFetch = args.fetch ?? fetch;
  const now = args.now ?? Date.now;
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(args.config.projectId)}/messages:send`;
  let cached: { token: string; expiresAt: number } | null = null;
  let exchanging: Promise<string> | null = null;

  const exchange = async (): Promise<string> => {
    const assertion = signServiceAccountAssertion({
      clientEmail: args.config.clientEmail,
      tokenUri: args.config.tokenUri,
      key,
      issuedAtSeconds: Math.floor(now() / 1000),
    });
    const response = await doFetch(args.config.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('FCM token exchange failed with status ' + String(response.status));
    const parsed = tokenResponseSchema.parse(await response.json());
    cached = { token: parsed.access_token, expiresAt: now() + parsed.expires_in * 1000 };
    return parsed.access_token;
  };

  const accessToken = async (): Promise<string> => {
    if (cached !== null && now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached.token;
    // Concurrent sends share one exchange.
    exchanging ??= exchange().finally(() => {
      exchanging = null;
    });
    return exchanging;
  };

  return {
    async send(target, payload): Promise<PushOutcome> {
      try {
        const response = await doFetch(sendUrl, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + (await accessToken()), 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: target.token,
              notification: { title: payload.title, body: payload.body },
              data: payload.data,
              android: { priority: 'HIGH', notification: { sound: 'default' } },
            },
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return 'sent';
        const body = await response.text();
        // The access token was refused (revoked key, clock skew): drop it so the next send exchanges a new one.
        if (response.status === 401) cached = null;
        if (isDeadTokenResponse(response.status, body)) return 'invalid_token';
        args.onError?.('FCM rejected push', { status: response.status, body: body.slice(0, 200) });
        return 'failed';
      } catch (err) {
        args.onError?.('FCM request failed', { err: err instanceof Error ? err.message : String(err) });
        return 'failed';
      }
    },
  };
}
