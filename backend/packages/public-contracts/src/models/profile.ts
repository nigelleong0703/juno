import { z } from 'zod';
import { isoDateTimeSchema } from './common.js';

/** Safety bounds on the whole document (entries, serialized), so the store cannot be abused; not a product limit. */
export const MAX_PROFILE_ENTRIES = 200;
export const MAX_PROFILE_BYTES = 256 * 1024;

/**
 * Who may see an entry through the agent: `private` entries reach the agent only in runs that serve the owner alone (a direct
 * chat, the owner's own tasks); `shared` ones also in rooms and channels with other people.
 */
export const profileVisibilitySchema = z.enum(['private', 'shared']);
export type ProfileVisibility = z.infer<typeof profileVisibilitySchema>;

export const profileKeySchema = z.string().trim().min(1).max(60);
export const profileValueSchema = z.string().trim().min(1).max(2000);

/** Where an entry came from: the agent that learned it (and the chat), or the user who typed it. */
export const profileSourceSchema = z.object({
  by: z.enum(['agent', 'user']),
  agentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  at: isoDateTimeSchema,
}).strict();
export type ProfileSource = z.infer<typeof profileSourceSchema>;

/**
 * One detail about the user: a human key ("Name", "Work email", "Home address", "KrisFlyer number") and a free-text value
 * (multi-line for an address). No type: the agent works out what a value is when it fills a form.
 */
export const profileEntrySchema = z.object({
  id: z.string().min(1),
  key: profileKeySchema,
  value: profileValueSchema,
  visibility: profileVisibilitySchema.default('private'),
  source: profileSourceSchema,
}).strict();
export type ProfileEntry = z.infer<typeof profileEntrySchema>;

/**
 * The account profile (BACKEND 8.7): what the user supplies that is not secret, one flat list. Mostly written by the agent as
 * it learns things, editable by the user, filled into pages by the agent itself (no secure-input sheet). Secrets (passwords,
 * card details, one-time codes, government ID numbers) never live here.
 */
export const profileBodySchema = z.object({ entries: z.array(profileEntrySchema) }).strict();
export type ProfileBody = z.infer<typeof profileBodySchema>;

/** `GET /v1/profile` reply. Empty entries when nothing is saved. */
export const profileSchema = profileBodySchema.extend({ updatedAt: isoDateTimeSchema.optional() });
export type Profile = z.infer<typeof profileSchema>;

/** One entry of a `PUT` body: the server stamps `source` (user) on new or changed entries and keeps it on unchanged ones. */
export const putProfileEntrySchema = z.object({
  id: z.string().min(1),
  key: profileKeySchema,
  value: profileValueSchema,
  visibility: profileVisibilitySchema.default('private'),
}).strict();

/** Body of `PUT /v1/profile`: replaces the whole list. */
export const putProfileInputSchema = z.object({ entries: z.array(putProfileEntrySchema) }).strict().superRefine((body, ctx) => {
  const problem = profileSizeProblem(body);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  body.entries.forEach((entry, index) => {
    const secret = profileSecretProblem(entry.key, entry.value);
    if (secret !== undefined) ctx.addIssue({ code: 'custom', path: ['entries', index], message: secret });
  });
});
export type PutProfileInput = z.infer<typeof putProfileInputSchema>;

/** Why the list is too big, or undefined: the only bound on a profile (see MAX_PROFILE_ENTRIES). */
export function profileSizeProblem(body: { entries: unknown[] }): string | undefined {
  if (body.entries.length > MAX_PROFILE_ENTRIES) return `a profile holds at most ${MAX_PROFILE_ENTRIES} entries`;
  if (JSON.stringify(body).length > MAX_PROFILE_BYTES) return `a profile is at most ${MAX_PROFILE_BYTES / 1024} KB`;
  return undefined;
}

const SECRET_KEY = /passw|passcode|密码|\bpin\b|cvc|cvv|csc|security code|one.?time|\botp\b|verification code|验证码|card (number|no)|信用卡|银行卡|卡号|nric|passport (number|no)|\bssn\b|social security|national id|\bid (number|no)\b|identity (card|number)|身份证|护照/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * Why this entry looks like a secret (a password, card number, one-time code, government ID number), or undefined. Judged from
 * the key's words and from a value that is a card number; secrets go through request_secure_input or the secure vault instead.
 */
export function profileSecretProblem(key: string, value: string): string | undefined {
  const message = 'looks like a secret (password, card number, code or ID number); secrets are never saved to the profile';
  if (SECRET_KEY.test(key)) return `"${key}" ${message}`;
  const compact = value.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(compact) && luhn(compact)) return `"${key}" ${message}`;
  return undefined;
}

/** The row id of an owner's profile (`profiles` collection): one row per owner. */
export function profileIdFor(ownerId: string): string {
  return `profile-${ownerId}`;
}
