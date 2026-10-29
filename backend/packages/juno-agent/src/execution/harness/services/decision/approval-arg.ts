import { decisionCategorySchema, type DecisionCategory } from '@agent-desktop/public-contracts';

/**
 * The `approval` argument the harness adds to every action tool (BACKEND 8.1): the agent tells the story (what, why, what
 * happens if refused); the server states the facts from the real call. Read leniently: a malformed part is dropped, the call is
 * never refused for it (that would stall a routine), it just cannot be auto-allowed without a sentence.
 */
export const APPROVAL_ARG = 'approval';

export const SENTENCE_MAX = 160;
export const WHY_MAX = 240;

/** What the agent expects the call to do. The server verifies what it can and ignores the rest. */
export interface AgentFacts {
  money?: { amount: string; currency: string; recurring?: 'weekly' | 'monthly' | 'yearly'; merchant?: string };
  recipients?: string[];
  reversible?: 'yes' | 'hard' | 'no';
}

export interface AgentApproval {
  sentence?: string;
  why?: string;
  ifDenied?: string;
  categories: DecisionCategory[];
  facts: AgentFacts;
}

const NATIVE_WHEN = 'Required for spending, sending/posting to others, commitments, permanent deletion, account/settings changes. User approval precedes execution; omit otherwise.';
const MCP_WHEN = 'Always required for this action; the user decides first. Missing details prevent advance approval.';

/** The model-facing schema of the `approval` argument; `always` for a connected app's action tool, which always asks. */
export function approvalSchema(always: boolean) {
  return {
  type: 'object',
  description: (always ? MCP_WHEN : NATIVE_WHEN),
  properties: {
    sentence: { type: 'string', description: 'One plain sentence describing the action.' },
    why: { type: 'string', description: 'Why you want to do it.' },
    ifDenied: { type: 'string', description: 'What you will do if the user says no.' },
    categories: {
      type: 'array',
      items: { type: 'string', enum: decisionCategorySchema.options },
      description: 'Applicable categories; these can only tighten server policy.',
    },
    facts: {
      type: 'object',
      description: 'Expected effects, verified against the real call.',
      properties: {
        money: { type: 'object', properties: { amount: { type: 'string' }, currency: { type: 'string' } } },
        recipients: { type: 'array', items: { type: 'string' } },
        reversible: {
          type: 'string',
          enum: ['yes', 'hard', 'no'],
          description: '"yes": easily undone. "hard": undone only with effort or a cost (a card charge or a sent message: refund, retraction). "no": can never be undone by anyone (permanent deletion); a "no" always asks the user and can never be allowed in advance. Leave it out when unsure.',
        },
      },
    },
  },
  required: ['sentence'],
  } as const;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

const AMOUNT = /^\d+(\.\d{1,6})?$/;

function factsOf(value: unknown): AgentFacts {
  if (!isRecord(value)) return {};
  const facts: AgentFacts = {};
  const money = value['money'];
  if (isRecord(money)) {
    const amount = typeof money['amount'] === 'number' ? String(money['amount']) : text(money['amount'], 32);
    const currency = text(money['currency'], 8)?.toUpperCase();
    if (amount !== undefined && AMOUNT.test(amount) && currency !== undefined && /^[A-Z]{3,8}$/.test(currency)) {
      const recurring = money['recurring'];
      const merchant = text(money['merchant'], 120);
      facts.money = {
        amount,
        currency,
        ...(recurring === 'weekly' || recurring === 'monthly' || recurring === 'yearly' ? { recurring } : {}),
        ...(merchant === undefined ? {} : { merchant }),
      };
    }
  }
  const recipients = value['recipients'];
  if (Array.isArray(recipients)) {
    const names = recipients.map((entry) => text(entry, 200)).filter((entry): entry is string => entry !== undefined).slice(0, 20);
    if (names.length > 0) facts.recipients = names;
  }
  const reversible = value['reversible'];
  if (reversible === 'yes' || reversible === 'hard' || reversible === 'no') facts.reversible = reversible;
  return facts;
}

/** The agent's approval from a call's arguments; `confirm` (the older one-sentence form) counts as just a sentence. */
export function readApproval(args: unknown): AgentApproval | undefined {
  if (!isRecord(args)) return undefined;
  const raw = args[APPROVAL_ARG];
  const legacy = text(args['confirm'], SENTENCE_MAX);
  if (!isRecord(raw)) return legacy === undefined ? undefined : { sentence: legacy, categories: [], facts: {} };
  const categories = Array.isArray(raw['categories'])
    ? raw['categories'].flatMap((entry) => {
        const parsed = decisionCategorySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const sentence = text(raw['sentence'], SENTENCE_MAX) ?? legacy;
  const why = text(raw['why'], WHY_MAX);
  const ifDenied = text(raw['ifDenied'], SENTENCE_MAX);
  return {
    ...(sentence === undefined ? {} : { sentence }),
    ...(why === undefined ? {} : { why }),
    ...(ifDenied === undefined ? {} : { ifDenied }),
    categories: [...new Set(categories)],
    facts: factsOf(raw['facts']),
  };
}

/** The sentence the agent gave for a call (`approval.sentence`, else `confirm`), or '' when there is none. */
export function sentenceOf(args: unknown): string {
  return readApproval(args)?.sentence ?? '';
}
