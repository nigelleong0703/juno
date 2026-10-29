import { z } from 'zod';
import { idSchema, isoDateTimeSchema, requestStatusSchema } from './common.js';
import { screenRectSchema } from './computer.js';
import type { RequestOutcome } from './decision.js';
import { decisionBriefSchema, delegationDraftSchema, delegationOfferSchema, requestOutcomeSchema } from './decision.js';
import { uiDocSchema } from './ui.js';

export const requestKindSchema = z.enum(['approval', 'question', 'signin', 'admin', 'computer', 'secure_input', 'connect']);
export type RequestKind = z.infer<typeof requestKindSchema>;

export const requestDecisionSchema = z.object({
  /** Member id, or `auto` when a rule decided it. */
  by: idSchema,
  at: isoDateTimeSchema,
  mode: z.enum(['auto', 'manual']),
  scope: z.enum(['once', 'always_recipient', 'always', 'delegate', 'app']),
  /** Free-text note left by the decider (e.g. an edited draft). */
  note: z.string().optional(),
  /** Why a request ended other than by a plain yes or no: sent back to change, timed out, cancelled. */
  reason: z.enum(['revise', 'timeout', 'cancelled']).optional(),
});
export type RequestDecision = z.infer<typeof requestDecisionSchema>;

// --- Per-kind payloads ------------------------------------------------------

export const approvalPurchaseSchema = z.object({
  merchant: z.string().min(1).max(200),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).max(10_000).optional(),
        /** As shown on the page, e.g. "S$2,399.00". */
        price: z.string().max(64).optional(),
      }),
    )
    .max(20),
  total: z.string().max(64).optional(),
  /** ISO 4217 code when known, e.g. "SGD". */
  currency: z.string().max(8).optional(),
  /** As shown on the page, e.g. "Visa •••• 4242"; never a full card number. */
  paymentMethod: z.string().max(64).optional(),
  /** Where and when it arrives, as shown on the page, e.g. "Deliver to 1 Orchard Rd, Fri 18 Oct". */
  delivery: z.string().max(120).optional(),
});
export type ApprovalPurchase = z.infer<typeof approvalPurchaseSchema>;

export const approvalPayloadSchema = z.object({
  kind: z.literal('approval'),
  /** What the agent wants to do, e.g. "Send email". */
  action: z.string().min(1),
  /** Who/where, e.g. "team@example.com". */
  target: z.string().optional(),
  /** Why the agent wants to do it. */
  why: z.string().min(1),
  /** A short line under the draft (batch 5b): a send to someone else from a run only the owner is in, drafted with the private memory in view. */
  notice: z.string().max(200).optional(),
  app: z.string().optional(),
  site: z.string().optional(),
  recipient: z.string().optional(),
  /** Optional draft the user can "Edit before sending". */
  draft: z
    .object({
      subject: z.string().optional(),
      body: z.string(),
    })
    .optional(),
  /** What a purchase approval buys, as the agent read it off the page (untrusted page data, for the card UI). */
  purchase: approvalPurchaseSchema.optional(),
  /**
   * A screenshot of the screen when the approval was raised. `libraryId` is an image in the owner's
   * library: fetch its bytes with `GET /v1/library/:id/download`.
   */
  preview: z.object({ libraryId: idSchema, capturedAt: isoDateTimeSchema }).optional(),
  /**
   * The card to render, built by the server (never the model) from `purchase` and `preview`: items with the total, delivery
   * and payment facts, the consequence and the screenshot. Clients render it with the UI blocks; `purchase`/`preview` stay for reference.
   */
  ui: uiDocSchema.optional(),
  /** 0.22.0: the decision brief (what, why, if denied, kind of decision, platform, verified facts). Absent on older requests. */
  brief: decisionBriefSchema.optional(),
  /** 0.22.0: whether "allow this kind" can be offered, and the limits it would start with. */
  delegationOffer: delegationOfferSchema.optional(),
  /**
   * 0.52.0: an agent wants to use an app on the owner's Mac. `purpose: 'use'` is "<Agent> wants to use <App> on your Mac": Allow once
   * (`approve`), Always allow (`approve` with `scope: 'app'`, kept per app until `DELETE /v1/mac/apps/:app`), Don't allow (`deny`).
   * `purpose: 'foreground'` is "<App> needs to come to the front for this: OK?": one tap, never remembered.
   */
  macApp: z.object({ app: z.string().min(1), name: z.string().min(1), purpose: z.enum(['use', 'foreground']) }).optional(),
});
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{5,24}$/;

function isRealDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

export type QuestionValidation = { ok: true } | { errors: Record<string, string> };

/**
 * A question is a `UiDoc` with exactly one interactive block (`choices` or `fields`, BACKEND 8.7.1). `answers` is set
 * once answered: keyed by the choices block id (value: an option id, or a JSON array string of ids when `multiple`)
 * or by each field id (value: the text as typed). `validateUiAnswers` checks them.
 */
export const questionPayloadSchema = z.object({
  kind: z.literal('question'),
  ui: uiDocSchema,
  answers: z.record(z.string(), z.string()).optional(),
});
export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

export const signinPayloadSchema = z.object({
  kind: z.literal('signin'),
  site: z.string().min(1),
  url: z.string(),
  reason: z.string().optional(),
  /** Whether the model is paused while the user signs in (SPEC 4.3). */
  pausesModel: z.boolean(),
});
export type SigninPayload = z.infer<typeof signinPayloadSchema>;

export const adminPayloadSchema = z.object({
  kind: z.literal('admin'),
  app: z.string().min(1),
  /** Who is asking (e.g. "Slack workspace admin"). */
  requester: z.string().min(1),
  reason: z.string().min(1),
  details: z.string().optional(),
});
export type AdminPayload = z.infer<typeof adminPayloadSchema>;

/**
 * The agent needs the user on its screen (a captcha, an unusual sign-in): a focused take-over. `focus`
 * is the element it is stuck on, with its rect in the screen's framebuffer pixels (see `screenRectSchema`)
 * measured at `previewAt`, so a client can zoom to it. The request resolves when the user hands control
 * back (`approved`) or says they cannot help (`deny` → `denied`).
 */
export const computerPayloadSchema = z.object({
  kind: z.literal('computer'),
  reason: z.string().min(1),
  url: z.string().optional(),
  site: z.string().optional(),
  focus: z
    .object({
      rect: screenRectSchema,
      /** Untrusted page text (the element's accessible name). */
      label: z.string().optional(),
      role: z.string().optional(),
      ref: z.string().optional(),
    })
    .optional(),
  screenId: idSchema.optional(),
  /** When `focus.rect` was measured; the page may have moved since. */
  previewAt: isoDateTimeSchema.optional(),
});
export type ComputerPayload = z.infer<typeof computerPayloadSchema>;

/**
 * What a page field wants. Secrets: `password`, `card_number` (Luhn, 12-19 digits), `card_expiry` (MM/YY or
 * MM/YYYY), `card_cvc` (3-4 digits), `otp` (4-10 digits). Plain details: `text`, `name`, `email`, `phone`,
 * `address`, `city`, `country`, `postal_code`, `month` (1-12), `year` (4 digits, not in the past),
 * `date` (YYYY-MM-DD), `number`. Values are secret whatever the kind (see `secureInputPayloadSchema`).
 */
export const secureInputFieldKindSchema = z.enum([
  'password',
  'card_number',
  'card_expiry',
  'card_cvc',
  'otp',
  'text',
  'name',
  'email',
  'phone',
  'address',
  'city',
  'country',
  'postal_code',
  'month',
  'year',
  'date',
  'number',
]);
export type SecureInputFieldKind = z.infer<typeof secureInputFieldKindSchema>;

export const MAX_VAULT_ENTRIES = 64;

export const secureInputFieldSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(80),
  kind: secureInputFieldKindSchema,
  /** The page field the value is typed into (a browser snapshot ref like e12). */
  ref: z.string().optional(),
  /** False when the page marks the field optional; absent means required. */
  required: z.boolean().optional(),
  placeholder: z.string().max(120).optional(),
  maxLength: z.number().int().positive().optional(),
  /** Bounds for `number`, `month` and `year`. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** The values a page `<select>` offers; the answer must be one of them. */
  options: z.array(z.string().max(80)).max(100).optional(),
  /**
   * The id of the owner's vault entry (`PUT /v1/secure-vault/keys`) the agent judged to fit this field: the client may
   * prefill it from the vault on the phone. Values never reach the server.
   */
  vaultId: idSchema.optional(),
  /** Set once the user submitted: whether the value reached the field. Never the value itself. */
  status: z.enum(['filled', 'failed']).optional(),
});
export type SecureInputField = z.infer<typeof secureInputFieldSchema>;

/**
 * How a client encrypts values for this request (BACKEND 8.7): the public half of the sandbox's own X25519 key.
 * For each value the client makes an ephemeral X25519 key pair, derives `HKDF-SHA256(X25519(ephemeral private,
 * publicKey), salt = UTF-8 request id, info = "juno-secure-input-v1")` (32 bytes) and encrypts the UTF-8 value with
 * AES-256-GCM, a random 12-byte nonce and AAD `"<requestId>|<fieldId>|<ref>"`. Test vector: `secure-input-vector.json`.
 */
export const SECURE_INPUT_ALG = 'X25519-HKDF-SHA256-AES256GCM';
export const secureInputEncryptionSchema = z.object({
  alg: z.literal(SECURE_INPUT_ALG),
  /** Names the sandbox key (first 8 bytes of sha256 of the public key, hex); a new sandbox has a new key. */
  keyId: z.string().min(1).max(64),
  /** Raw 32-byte X25519 public key, base64. */
  publicKey: z.string().min(1).max(64),
});
export type SecureInputEncryption = z.infer<typeof secureInputEncryptionSchema>;

/**
 * Secret values the page needs (a password, a card, a one-time code). The user types them in a native
 * form, encrypts each one to `encryption` and submits them with `POST /v1/requests/:id/secure-input`; only the
 * sandbox decrypts them and types them into the page fields. The values are never stored, logged, readable by the
 * backend, sent to the agent or echoed back.
 */
export const secureInputPayloadSchema = z.object({
  kind: z.literal('secure_input'),
  site: z.string().min(1),
  url: z.string().optional(),
  reason: z.string().min(1),
  fields: z.array(secureInputFieldSchema).min(1).max(8),
  /** Present on every request raised since contracts 0.10.0; a request with it accepts only encrypted values. */
  encryption: secureInputEncryptionSchema.optional(),
});
export type SecureInputPayload = z.infer<typeof secureInputPayloadSchema>;

/**
 * Why an app is not usable by the agent that needs it: the one access state per owner, agent and app (no problem = `ready`). The Connect
 * card and the error the model gets for a refused tool call both come from it (BACKEND 10.18.1).
 * `not_added`: no account is signed in. `not_enabled`: added, but off for this agent. `needs_reconnect`: added, but the sign-in never
 * finished or never worked. `expired`: it worked and the provider now rejects the sign-in (expired or withdrawn). `scope_missing`: signed
 * in, but the provider wants a permission the sign-in lacks. `not_granted`: usable, but the call changes things and Actions is off for
 * this agent (a per-tool state: it never appears on a Connect card).
 */
export const appProblemSchema = z.enum(['not_added', 'not_enabled', 'needs_reconnect', 'expired', 'scope_missing', 'not_granted']);
export type AppProblem = z.infer<typeof appProblemSchema>;

/**
 * An agent needs an app it cannot use yet: the card in its chat has a button per app id. `not_added`: add it on the Apps page
 * (`POST /v1/apps/:id/install`); `not_enabled`: it is added but off for this agent (`PUT /v1/agents/:agentId/apps/:appId`);
 * `needs_reconnect`, `expired` and `scope_missing`: sign in again (`POST /v1/apps/:id/install` with the account's `connectionId`; for
 * `scope_missing` the new sign-in asks for the missing permission). The server resolves the card by itself once one of
 * the listed apps is usable by the agent; the owner can also dismiss it (`deny`).
 */
export const connectPayloadSchema = z.object({
  kind: z.literal('connect'),
  /** The apps that would satisfy the need (any one); each is an app id (a connector catalog id), or `mac`. */
  appIds: z.array(z.string().min(1)).min(1).max(8),
  /** Why each listed app is not usable now; `mac` has no entry. */
  problems: z.record(z.string(), appProblemSchema).optional(),
  /** Human name of what is missing, e.g. "Google Calendar or Outlook". */
  label: z.string().min(1).max(160),
  /** The routine on hold for this app; absent on a card the agent raised in chat (onboarding). */
  routineId: idSchema.optional(),
});
export type ConnectPayload = z.infer<typeof connectPayloadSchema>;

export const requestPayloadSchema = z.discriminatedUnion('kind', [
  approvalPayloadSchema,
  questionPayloadSchema,
  signinPayloadSchema,
  adminPayloadSchema,
  computerPayloadSchema,
  secureInputPayloadSchema,
  connectPayloadSchema,
]);
export type RequestPayload = z.infer<typeof requestPayloadSchema>;

export const requestSchema = z.object({
  id: idSchema,
  kind: requestKindSchema,
  status: requestStatusSchema,
  title: z.string().min(1),
  summary: z.string(),
  agentId: idSchema,
  conversationId: idSchema.optional(),
  runId: idSchema.optional(),
  /** The rule that escalated this action (SPEC 4.7 "which rule triggered it"). */
  triggeringRuleId: idSchema.optional(),
  payload: requestPayloadSchema,
  decision: requestDecisionSchema.optional(),
  /** 0.22.0, approvals only, set by the server once decided: how it ended. Never stored, derived from status + decision. */
  outcome: requestOutcomeSchema.optional(),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.optional(),
});
export type Request = z.infer<typeof requestSchema>;

/** How a decided approval ended, from its status and decision; undefined for a pending request or another kind. Clients translate, never derive. */
export function deriveRequestOutcome(request: Pick<Request, 'status' | 'decision' | 'payload'>): RequestOutcome | undefined {
  if (request.payload.kind !== 'approval') return undefined;
  const decision = request.decision;
  if (request.status === 'approved') return decision?.mode === 'auto' ? 'allowed_rule' : 'allowed_once';
  if (request.status === 'denied') return decision?.reason === 'revise' ? 'revised' : 'denied';
  if (request.status === 'expired') return decision?.reason === 'timeout' ? 'timed_out' : 'cancelled';
  return undefined;
}

export const requestActionSchema = z.enum(['approve', 'deny', 'answer']);
export type RequestAction = z.infer<typeof requestActionSchema>;

/** Input accepted by `requests.resolve()` (DecisionBar in §5.3). */
export const resolveRequestInputSchema = z.object({
  action: requestActionSchema,
  /**
   * `always` (approval + approve only, kept for older clients): also create an auto rule for this tool, for this agent;
   * never given for spending, irreversible or sensitive decisions. `delegate` (0.22.0): approve this one and create the
   * delegations of `delegations` (default: the request's `delegationOffer.suggested`), for this agent.
   */
  scope: z.enum(['once', 'always_recipient', 'always', 'delegate', 'app']).optional(),
  /** With `scope: 'delegate'`: the delegations to create (the offer's limits, edited by the owner). */
  delegations: z.array(delegationDraftSchema).max(4).optional(),
  /** With `deny`: `revise` = sent back to change, the note says what; the agent receives it. */
  reason: z.literal('revise').optional(),
  /** Answers keyed by question field id (for `action: 'answer'`). */
  answers: z.record(z.string(), z.string()).optional(),
  /** Edited draft body, for "Edit before sending". */
  editedDraft: z.string().optional(),
  note: z.string().optional(),
  by: idSchema.optional(),
  mode: z.enum(['auto', 'manual']).optional(),
});
export type ResolveRequestInput = z.infer<typeof resolveRequestInputSchema>;

/** Longest secret value accepted for one field (a passphrase; a card number is 19 digits). */
export const SECURE_INPUT_MAX_VALUE = 512;

/** One value sealed to the sandbox key (see `secureInputEncryptionSchema`); all base64. */
export const sealedSecureValueSchema = z.object({
  /** The client's ephemeral X25519 public key, raw 32 bytes. */
  epk: z.string().min(1).max(64),
  /** Random 12 bytes. */
  nonce: z.string().min(1).max(32),
  /** AES-256-GCM output: the encrypted UTF-8 value followed by the 16-byte tag. */
  ciphertext: z.string().min(1).max(2_800),
}).strict();
export type SealedSecureValue = z.infer<typeof sealedSecureValueSchema>;

/**
 * Body of `POST /v1/requests/:id/secure-input`: one sealed value per field id of the request (an optional field the
 * user left empty is simply absent). Plaintext `values` are rejected (400 `ENCRYPTION_REQUIRED`).
 */
export const submitSecureInputSchema = z.object({
  fields: z
    .record(z.string().min(1).max(64), sealedSecureValueSchema)
    .refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 8, {
      message: 'between 1 and 8 values',
    }),
}).strict();
export type SubmitSecureInput = z.infer<typeof submitSecureInputSchema>;

/** Storing a card verification code or a one-time code is never allowed, whatever the entry is called. */
const FORBIDDEN_VAULT_LABEL = /\b(cvc2?|cvv2?|cid|csc|security code|verification code|one[- ]?time|otp|2fa|authenticator|passcode sms)\b/i;

/** One vault entry the owner keeps on the phone: a free label the agent reads, never the value. */
export const secureVaultEntrySchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(60).refine((label) => !FORBIDDEN_VAULT_LABEL.test(label), 'card verification codes and one-time codes cannot be stored'),
  kind: z.enum(['card', 'password', 'code', 'other']),
}).strict();
export type SecureVaultEntry = z.infer<typeof secureVaultEntrySchema>;

/** Body of `PUT /v1/secure-vault/keys` (replaces the list) and reply of `GET`: the names of what the owner keeps on the phone. */
export const secureVaultKeysSchema = z.object({
  entries: z.array(secureVaultEntrySchema).max(MAX_VAULT_ENTRIES),
}).strict();
export type SecureVaultKeys = z.infer<typeof secureVaultKeysSchema>;

/** The row id of an owner's vault key names (`secureVault` collection): one row per owner. */
export function secureVaultIdFor(ownerId: string): string {
  return `secure-vault-${ownerId}`;
}

/** Reply of `POST /v1/requests/:id/secure-input`: the resolved request and each field's outcome (no values). */
export const secureInputResultSchema = z.object({
  request: requestSchema,
  fields: z.array(
    z.object({
      id: idSchema,
      status: z.enum(['filled', 'failed']),
      /** Why the value did not reach the field (e.g. the page changed). */
      error: z.string().optional(),
    }),
  ),
});
export type SecureInputResult = z.infer<typeof secureInputResultSchema>;

// --- Secure-input value validation ------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function checkSecureValue(field: SecureInputField, value: string, now: Date): string | undefined {
  const digits = value.replace(/[\s-]/g, '');
  switch (field.kind) {
    case 'card_number':
      return /^\d{12,19}$/.test(digits) && luhn(digits) ? undefined : 'Enter a valid card number';
    case 'card_expiry':
      return /^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/.test(value) ? undefined : 'Enter the expiry as MM/YY';
    case 'card_cvc':
      return /^\d{3,4}$/.test(value) ? undefined : 'Enter the 3 or 4 digit security code';
    case 'otp':
      return /^\d{4,10}$/.test(digits) ? undefined : 'Enter the digits of the code';
    case 'email':
      return EMAIL.test(value) ? undefined : 'Enter a valid email address';
    case 'phone':
      return PHONE.test(value) && value.replace(/\D/g, '').length >= 5 ? undefined : 'Enter a valid phone number';
    case 'month': {
      const lo = field.min ?? 1;
      const hi = field.max ?? 12;
      if (!/^\d{1,2}$/.test(value)) return 'Enter the month as a number';
      return Number(value) >= lo && Number(value) <= hi ? undefined : `Month must be ${lo} to ${hi}`;
    }
    case 'year': {
      if (!/^\d{4}$/.test(value)) return 'Enter the year as 4 digits';
      const year = Number(value);
      if (year < now.getUTCFullYear()) return 'The year is in the past';
      if (field.min !== undefined && year < field.min) return `Year must be at least ${field.min}`;
      if (field.max !== undefined && year > field.max) return `Year must be at most ${field.max}`;
      return undefined;
    }
    case 'date':
      return DATE.test(value) && isRealDate(value) ? undefined : 'Enter a date as YYYY-MM-DD';
    case 'number': {
      if (!DECIMAL.test(value)) return 'Enter a number';
      const n = Number(value);
      if (field.min !== undefined && n < field.min) return `Must be at least ${field.min}`;
      if (field.max !== undefined && n > field.max) return `Must be at most ${field.max}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Check the values of a secure-input form (field id -> value) against its fields before anything is typed
 * into the page. Same shape as `validateQuestionAnswers`. The messages never quote a value. An empty value
 * is an error only for a required field (`required !== false`); an empty optional field is left unfilled.
 * `now` is only for tests (the "year not in the past" rule).
 */
export function validateSecureInputValues(
  fields: readonly SecureInputField[],
  values: Record<string, string>,
  now: Date = new Date()
): QuestionValidation {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.id] ?? '').trim();
    if (value.length === 0) {
      if (field.required !== false) errors[field.id] = 'Required';
      continue;
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      errors[field.id] = `Must be at most ${field.maxLength} characters`;
      continue;
    }
    if (field.options && field.options.length > 0 && !field.options.includes(value)) {
      errors[field.id] = 'Choose one of the offered options';
      continue;
    }
    const problem = checkSecureValue(field, value, now);
    if (problem) errors[field.id] = problem;
  }
  return Object.keys(errors).length === 0 ? { ok: true } : { errors };
}
