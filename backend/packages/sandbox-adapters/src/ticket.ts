/**
 * Short-lived signed tickets for one screen's VNC websocket. The VNC servers are loopback-only and
 * passwordless, so the ticket is the sole credential a client holds: the client proves it may open
 * \`/v1/screens/:id/vnc?t=<ticket>\`, and computerd re-checks the screen's current controller before
 * granting write access (BACKEND §7.2).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ScreenTicketClaims {
  screenId: string;
  ownerId: string;
  agentId: string;
  /** Read-write when the user has taken over, read-only when watching the agent. */
  control: boolean;
  /** The screen's `controlEpoch` when the ticket was signed: a read-write bridge refuses it once control has changed hands since. */
  epoch?: number;
  expiresAt: number;
}

export function signScreenTicket(claims: ScreenTicketClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return payload + '.' + signature(payload, secret);
}

export function verifyScreenTicket(token: string, secret: string, now = Date.now()): ScreenTicketClaims | null {
  const parts = token.split('.');
  const payload = parts[0];
  const mac = parts[1];
  if (!payload || !mac) return null;
  if (!safeEqual(mac, signature(payload, secret))) return null;
  const claims = parseClaims(payload);
  if (!claims) return null;
  if (claims.expiresAt <= now) return null;
  return claims;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseClaims(payload: string): ScreenTicketClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    typeof value['screenId'] !== 'string' ||
    typeof value['ownerId'] !== 'string' ||
    typeof value['agentId'] !== 'string' ||
    typeof value['control'] !== 'boolean' ||
    typeof value['expiresAt'] !== 'number'
  ) {
    return null;
  }
  return {
    screenId: value['screenId'],
    ownerId: value['ownerId'],
    agentId: value['agentId'],
    control: value['control'],
    ...(typeof value['epoch'] === 'number' ? { epoch: value['epoch'] } : {}),
    expiresAt: value['expiresAt'],
  };
}

