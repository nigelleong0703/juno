/**
 * Owner binding helpers. There are no codes the owner types or sends: the owner is bound from what the platform tells us (managed bot
 * creator, Slack installer / email lookup, Feishu approver / scanner, Discord inviter), or by confirming "Is this you?" in the Juno app
 * (owner-claim.ts).
 */
import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A fresh random secret (webhook secret) and its stored hash. */
export function newSecret(): { secret: string; hashHex: string } {
  const secret = randomBytes(24).toString('base64url');
  return { secret, hashHex: sha256Hex(secret) };
}

const START = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i;

/** `/start` (with or without a payload) is a deep-link open, never a message for the agent. */
export function isStartCommand(text: string): boolean {
  return START.test(text.trim());
}
