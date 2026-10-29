import type { DecisionCategory, DecisionFacts } from '@agent-desktop/public-contracts';
import type { ToolOrigin } from '../../../../contracts/index.js';
import { words } from '../../../../modules/mcp/tool-access.js';
import { instantOf } from './time.js';

/**
 * What the server can tell about a connector call from the REAL arguments, the connection it runs on and a small table per
 * catalog entry (BACKEND 8.1). Everything returned here is `verified`; anything the arguments do not hold is left out, never
 * guessed, so a limit on it can never match (delegation matches verified facts only).
 */
export interface McpDerivation {
  verb: string;
  categories: DecisionCategory[];
  facts: DecisionFacts;
  /** The text that goes out (subject, body, comment...), digested into the binding. */
  content: string[];
}

type Args = Record<string, unknown>;

const isRecord = (value: unknown): value is Args => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Argument keys that name who a call is addressed to. A recipient the text of a body mentions does not count (prompt injection). */
export const RECIPIENT_KEYS: readonly string[] = ['to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'address', 'channel', 'chat_id'];
const INVITEE_KEYS: readonly string[] = ['attendees', 'guests', 'invitees', 'participants'];
const CONTENT_KEYS: readonly string[] = ['subject', 'body', 'text', 'message', 'content', 'description', 'title', 'comment', 'summary', 'caption'];
const SECRET_KEYS: readonly string[] = ['password', 'secret', 'token', 'api_key', 'apikey', 'credentials', 'credential'];

const DELETE_WORDS = ['delete', 'remove', 'trash', 'purge', 'erase', 'destroy', 'clear', 'void', 'cancel', 'drop'];
const SPEND_WORDS = ['pay', 'charge', 'payout', 'transfer', 'purchase', 'buy', 'subscribe', 'capture'];
const COMMIT_WORDS = ['accept', 'decline', 'rsvp', 'book', 'reserve'];
const SPEAK_WORDS = ['send', 'reply', 'respond', 'forward', 'draft', 'message', 'email', 'notify', 'post', 'comment'];
const TEAM_CATALOGS: ReadonlySet<string> = new Set(['linear', 'asana', 'notion', 'atlassian']);
const FILE_CATALOGS: ReadonlySet<string> = new Set(['google-drive', 'google-docs', 'google-sheets']);

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[;,]/).map((part) => part.trim()).filter((part) => part !== '');
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) {
    for (const key of ['email', 'address', 'name', 'id']) {
      const found = value[key];
      if (typeof found === 'string' && found.trim() !== '') return [found.trim()];
    }
  }
  return [];
}

function addressOf(entry: string): string | undefined {
  const match = /<([^<>\s@]+@[^<>\s]+)>/.exec(entry) ?? /^([^\s@<>]+@[^\s@<>]+)$/.exec(entry);
  return match?.[1]?.toLowerCase();
}

/** Everyone a call names as addressee (to/cc/bcc/channel/attendees...), once each; `count` is the true number when more than fit. */
export function recipientsOf(args: Args, keys: readonly string[]): { recipients: Array<{ name: string; address?: string }>; count: number } {
  const seen = new Map<string, { name: string; address?: string }>();
  for (const key of keys) {
    for (const entry of strings(args[key])) {
      const address = addressOf(entry);
      const id = address ?? entry.toLowerCase();
      if (!seen.has(id)) seen.set(id, { name: address ?? entry, ...(address === undefined ? {} : { address }) });
    }
  }
  const all = [...seen.values()];
  return { recipients: all.slice(0, 20), count: all.length };
}

const MINOR_DIGITS: Readonly<Record<string, number>> = { JPY: 0, KRW: 0, VND: 0, CLP: 0, BIF: 0, KWD: 3, BHD: 3, JOD: 3 };

function moneyOf(args: Args, minorUnits: boolean): DecisionFacts['money'] {
  const currencyRaw = args['currency'] ?? args['currency_code'];
  const currency = typeof currencyRaw === 'string' ? currencyRaw.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return undefined;
  for (const key of ['amount', 'total', 'price', 'unit_amount', 'amount_total', 'amount_due']) {
    const value = args[key];
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < 0) continue;
    const digits = MINOR_DIGITS[currency] ?? 2;
    const major = minorUnits ? number / 10 ** digits : number;
    return { amount: major.toFixed(Math.max(digits, 2)), currency, source: 'verified' };
  }
  return undefined;
}

/** The start of an event or booking, when the arguments name an unambiguous instant. */
function startOf(args: Args): string | undefined {
  const zone = ['timeZone', 'timezone', 'time_zone', 'tz'].map((key) => args[key]).find((value): value is string => typeof value === 'string');
  for (const key of ['start', 'start_time', 'startTime', 'start_datetime', 'when']) {
    const value = args[key];
    const raw = typeof value === 'string' ? value : isRecord(value) && typeof value['dateTime'] === 'string' ? value['dateTime'] : undefined;
    if (raw === undefined) continue;
    const innerZone = isRecord(value) && typeof value['timeZone'] === 'string' ? value['timeZone'] : zone;
    const instant = instantOf(raw, innerZone);
    if (instant !== undefined) return instant;
  }
  return undefined;
}

function textOf(args: Args): string[] {
  return CONTENT_KEYS.flatMap((key) => (typeof args[key] === 'string' ? [`${key}: ${String(args[key])}`] : []));
}

function targetsOf(args: Args, kind: 'file' | 'event' | 'record'): NonNullable<DecisionFacts['targets']> {
  const label = ['title', 'name', 'summary', 'subject'].map((key) => args[key]).find((value): value is string => typeof value === 'string' && value !== '');
  const ids = Object.entries(args).filter(([key]) => /(^|_)ids?$|Ids?$/.test(key)).flatMap(([, value]) => strings(value));
  if (ids.length > 1) return [{ kind, label: label ?? ids[0] ?? 'items', count: ids.length }];
  const id = ids[0];
  return id === undefined && label === undefined ? [] : [{ kind, label: label ?? id ?? 'item' }];
}

function isPublicShare(args: Args): boolean {
  const flat = JSON.stringify(args).toLowerCase();
  return /"type":"anyone"|"anyone":true|"public":true|anyone with the link|"link_sharing":true/.test(flat);
}

/** accept / decline / respond: from the tool's name, else from the answer in its arguments (`response: "accepted"`). */
function answerOf(args: Args, toks: readonly string[]): string {
  if (toks.includes('decline')) return 'decline';
  if (toks.includes('accept')) return 'accept';
  const given = ['response', 'responseStatus', 'response_status', 'status', 'rsvp'].map((key) => args[key]).find((value): value is string => typeof value === 'string');
  if (given === undefined) return 'respond';
  return /^(accept|accepted|yes)$/i.test(given.trim()) ? 'accept' : /^(decline|declined|no)$/i.test(given.trim()) ? 'decline' : 'respond';
}

/** Which of the tool-name words are present. */
const hasAny = (toks: readonly string[], list: readonly string[]): boolean => list.some((word) => toks.includes(word));

export function deriveMcp(origin: ToolOrigin, args: unknown): McpDerivation {
  const catalog = origin.catalogId;
  const toks = words(origin.toolName);
  const input = isRecord(args) ? args : {};
  // Zapier tools are opaque: their arguments mean whatever the zap says, so only the name's words count and no fact is produced.
  const opaque = catalog === 'zapier';
  const facts: DecisionFacts = {};
  const categories = new Set<DecisionCategory>();
  let verb = toks[0] ?? 'use';
  const content = opaque ? [] : textOf(input);
  if (origin.account !== undefined) facts.asAccount = { label: origin.account, ...(catalog === undefined ? {} : { catalogId: catalog }), source: 'verified' };

  const named = (keys: readonly string[]): ReturnType<typeof recipientsOf> => (opaque ? { recipients: [], count: 0 } : recipientsOf(input, keys));
  const invitees = named(INVITEE_KEYS);
  const addressees = named(RECIPIENT_KEYS);
  const audience = (kind: 'people' | 'room' | 'team' | 'public', who: ReturnType<typeof recipientsOf>): void => {
    facts.audience = { kind, count: who.count, recipients: who.recipients, source: 'verified' };
  };
  const speakTo = (who: ReturnType<typeof recipientsOf>): void => {
    categories.add('speaking');
    audience(input['channel'] !== undefined || input['chat_id'] !== undefined ? 'room' : 'people', who);
  };

  if (hasAny(toks, DELETE_WORDS)) {
    verb = 'delete';
    categories.add('irreversible');
    facts.reversible = { value: 'no', source: 'verified' };
    if (!opaque) facts.targets = targetsOf(input, catalog === 'google-calendar' ? 'event' : FILE_CATALOGS.has(catalog ?? '') ? 'file' : 'record');
  } else if (toks.includes('refund')) {
    verb = 'refund';
    categories.add('spending');
    categories.add('irreversible');
    facts.reversible = { value: 'no', how: 'A refund cannot be taken back', source: 'verified' };
  } else if (hasAny(toks, SPEND_WORDS)) {
    verb = 'pay';
    categories.add('spending');
  } else if (catalog === 'google-calendar' && (hasAny(toks, COMMIT_WORDS) || toks.includes('respond'))) {
    verb = answerOf(input, toks);
    categories.add('committing');
    const at = startOf(input);
    facts.commitments = [{ kind: 'meeting', text: verb === 'decline' ? 'Declines an invitation' : verb === 'accept' ? 'Accepts an invitation' : 'Answers an invitation', ...(at === undefined ? {} : { at }), source: 'verified' }];
  } else if (hasAny(toks, ['book', 'reserve'])) {
    verb = 'book';
    categories.add('committing');
    const at = startOf(input);
    if (at !== undefined) facts.commitments = [{ kind: 'booking', text: 'A booking', at, source: 'verified' }];
  } else if (toks.includes('publish')) {
    verb = 'publish';
    categories.add('public');
    audience('public', { recipients: [], count: 0 });
  } else if (toks.includes('share') || toks.includes('permission') || toks.includes('permissions')) {
    verb = 'share';
    if (isPublicShare(input)) {
      categories.add('public');
      audience('public', { recipients: [], count: 0 });
    } else if (invitees.count + addressees.count > 0) {
      speakTo(named([...RECIPIENT_KEYS, ...INVITEE_KEYS]));
    }
  } else if (catalog === 'google-calendar' && hasAny(toks, ['create', 'insert', 'add', 'schedule', 'update', 'invite'])) {
    verb = 'schedule';
    if (invitees.count > 0) {
      categories.add('speaking');
      categories.add('committing');
      audience('people', invitees);
      const at = startOf(input);
      facts.commitments = [{ kind: 'meeting', text: 'Invites people to a meeting', ...(at === undefined ? {} : { at }), source: 'verified' }];
    }
  } else if (hasAny(toks, SPEAK_WORDS) || toks.includes('invite')) {
    verb = toks.includes('reply') || toks.includes('respond') ? 'reply' : toks.includes('draft') ? 'draft' : toks.includes('invite') ? 'invite' : toks.includes('comment') || toks.includes('post') ? 'post' : 'send';
    const who = named([...RECIPIENT_KEYS, ...INVITEE_KEYS]);
    if (TEAM_CATALOGS.has(catalog ?? '') && who.count === 0) {
      categories.add('speaking');
      audience('team', who);
    } else if (who.count > 0 || catalog === 'gmail') {
      speakTo(who);
    } else {
      categories.add('speaking');
    }
    if (catalog === 'gmail') {
      const sends = verb !== 'draft';
      facts.reversible = sends
        ? { value: 'no', how: 'An email cannot be unsent', source: 'verified' }
        : { value: 'yes', how: 'Only a draft is created; nothing is sent', source: 'verified' };
    }
  } else if (TEAM_CATALOGS.has(catalog ?? '') && hasAny(toks, ['create', 'add', 'assign'])) {
    verb = 'create';
    categories.add('speaking');
    audience('team', { recipients: [], count: 0 });
  }

  if (!opaque) {
    const money = moneyOf(input, catalog === 'stripe');
    if (money !== undefined && categories.has('spending')) facts.money = money;
    if (SECRET_KEYS.some((key) => typeof input[key] === 'string')) {
      categories.add('sensitive');
      facts.sensitive = [{ kind: 'credentials', label: 'A credential is sent along', source: 'verified' }];
    }
  }
  return { verb, categories: [...categories], facts, content };
}
