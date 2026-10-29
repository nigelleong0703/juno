import type { DecisionCategory, DecisionFacts, DecisionPlatform } from '@agent-desktop/public-contracts';
import { sentenceOf } from './approval-arg.js';
import { DELETE, DELETE_SENTENCE, INSTALL, PURCHASE } from './patterns.js';
import { MAC_DESKTOP_TOOLS } from './mac.js';

/** What the server can tell about a call of the agent's own tools (browser, screen, shell, Juno tools): the table below plus the real arguments. */
export interface NativeDerivation {
  platform: DecisionPlatform;
  verb: string;
  categories: DecisionCategory[];
  facts: DecisionFacts;
  content: string[];
}

type Args = Record<string, unknown>;

const isRecord = (value: unknown): value is Args => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (args: Args, key: string): string => (typeof args[key] === 'string' ? args[key] : '');

const COMPUTER: DecisionPlatform = { kind: 'none', name: 'Computer' };
const MAC: DecisionPlatform = { kind: 'none', name: 'Your Mac' };
const JUNO: DecisionPlatform = { kind: 'juno', name: 'Juno' };

/** The host of the page the agent is on, without `www.`; from the active tab, never from what the agent says. */
export function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

/** "S$2,399.00" -> "2399.00"; "2.399,00" -> "2399.00". Undefined when no amount can be read. */
export function parseAmount(text: string): string | undefined {
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(cleaned)) return undefined;
  const lastSeparator = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  const decimals = lastSeparator < 0 ? '' : cleaned.slice(lastSeparator + 1);
  const hasDecimals = lastSeparator >= 0 && decimals.length >= 1 && decimals.length <= 2;
  const whole = (hasDecimals ? cleaned.slice(0, lastSeparator) : cleaned).replace(/[.,]/g, '');
  const amount = hasDecimals ? `${whole || '0'}.${decimals}` : whole;
  return /^\d+(\.\d{1,2})?$/.test(amount) ? amount : undefined;
}

/**
 * A click, key press or dialog in the browser or on the screen. The call carries no readable content, so the host is the one
 * verified fact (the active tab). The sentence the agent gave decides the categories, which can only make the request
 * stricter; money from its `purchase` stays `declared` until the page itself is read (BACKEND 8.1, later phase).
 */
export function deriveBrowser(args: unknown, pageUrl: string | undefined): NativeDerivation {
  const input = isRecord(args) ? args : {};
  const host = hostOf(pageUrl);
  const platform: DecisionPlatform = host === undefined ? { kind: 'none', name: 'Browser' } : { kind: 'site', name: host, host };
  const sentence = sentenceOf(args);
  const categories: DecisionCategory[] = [];
  const facts: DecisionFacts = {};
  const purchase = isRecord(input['purchase']) ? input['purchase'] : undefined;
  if (purchase !== undefined || PURCHASE.test(sentence)) categories.push('spending');
  if (DELETE_SENTENCE.test(sentence)) categories.push('irreversible');
  const total = purchase !== undefined && typeof purchase['total'] === 'string' ? parseAmount(purchase['total']) : undefined;
  const currency = purchase !== undefined && typeof purchase['currency'] === 'string' ? purchase['currency'].toUpperCase() : undefined;
  if (total !== undefined && currency !== undefined && /^[A-Z]{3}$/.test(currency)) {
    facts.money = { amount: total, currency, ...(host === undefined ? {} : { merchant: host }), source: 'declared' };
  }
  return { platform, verb: categories.includes('spending') ? 'purchase' : 'click', categories, facts, content: [] };
}

function removalTargets(command: string): NonNullable<DecisionFacts['targets']> {
  const match = /\brm\s+((?:-\S+\s+)*)([^;&|\n]*)/.exec(command);
  const paths = (match?.[2] ?? '').split(/\s+/).filter((part) => part !== '' && !part.startsWith('-')).slice(0, 20);
  return paths.map((label) => ({ kind: 'file' as const, label: label.slice(0, 160) }));
}

const PHONE: DecisionPlatform = { kind: 'none', name: 'Your iPhone' };

/**
 * Calendar and Reminders on the owner's iPhone: reads decide nothing, creating or changing is a "committing" decision, and a
 * delete or a change to a whole repeating series (span `future`) is "irreversible".
 */
function derivePhone(toolName: string, input: Args): NativeDerivation {
  const facts: DecisionFacts = {};
  const label = (str(input, 'title') || str(input, 'id')).slice(0, 160);
  if (label !== '') facts.targets = [{ kind: 'record', label }];
  const categories: DecisionCategory[] = [];
  const removes = toolName === 'phone_calendar_delete_event' || toolName === 'phone_reminders_delete';
  if (removes || str(input, 'span') === 'future') {
    categories.push('irreversible');
    facts.reversible = { value: 'no', source: 'verified' };
  } else if (/_(create|update)/.test(toolName)) {
    categories.push('committing');
  }
  return { platform: PHONE, verb: categories.length === 0 ? 'read' : 'change', categories, facts, content: [str(input, 'title'), str(input, 'start'), str(input, 'due')].filter((part) => part !== '') };
}

/** Tools of the agent's computer and of Juno itself. */
export function deriveNative(toolName: string, args: unknown, mac = false): NativeDerivation {
  const input = isRecord(args) ? args : {};
  if (toolName.startsWith('phone_')) return derivePhone(toolName, input);
  const facts: DecisionFacts = {};
  const categories: DecisionCategory[] = [];
  let platform = toolName.startsWith('shell.') || toolName.startsWith('files.') || toolName === 'computer.install_packages' ? (mac ? MAC : COMPUTER) : JUNO;
  let verb = 'run';
  if (mac && toolName.startsWith('files.') && str(input, 'path') !== '') {
    facts.targets = [{ kind: 'file', label: str(input, 'path').slice(0, 160) }];
    return { platform, verb: toolName === 'files.read' || toolName === 'files.search' ? 'read' : 'change', categories, facts, content: [str(input, 'path')] };
  }
  if (MAC_DESKTOP_TOOLS.has(toolName)) {
    // Working an app on the Mac: the app is the one verified fact; a commit-ish sentence from the agent tightens it like a browser click.
    const app = str(input, 'app').slice(0, 160);
    if (app !== '') facts.targets = [{ kind: 'record', label: app }];
    const sentence = sentenceOf(args);
    if (PURCHASE.test(sentence)) categories.push('spending');
    if (DELETE_SENTENCE.test(sentence)) categories.push('irreversible');
    return { platform: MAC, verb: toolName === 'computer.act' ? 'click' : 'read', categories, facts, content: [app, input['foreground'] === true ? 'foreground' : ''] };
  }
  if (toolName.startsWith('mac_')) {
    const to = Array.isArray(input['to']) ? input['to'].filter((v): v is string => typeof v === 'string').slice(0, 20) : [];
    if (to.length > 0) facts.targets = to.map((label) => ({ kind: 'record' as const, label: label.slice(0, 160) }));
    return { platform: MAC, verb: toolName === 'mac_mail_send' ? 'send' : 'change', categories: toolName === 'mac_mail_send' ? ['speaking'] : [], facts, content: [str(input, 'subject') || str(input, 'title')] };
  }
  if (toolName === 'computer_copy') {
    const label = [str(input, 'path'), str(input, 'toPath')].filter((part) => part !== '').join(' -> ').slice(0, 160);
    if (label !== '') facts.targets = [{ kind: 'file', label }];
    return { platform: MAC, verb: 'change', categories, facts, content: [label] };
  }
  if (toolName === 'shell.run' || toolName === 'shell.start') {
    const command = str(input, 'command');
    if (DELETE.test(command)) {
      categories.push('irreversible');
      facts.reversible = { value: 'no', source: 'verified' };
      const targets = removalTargets(command);
      if (targets.length > 0) facts.targets = targets;
    }
    if (INSTALL.test(command)) categories.push('setup');
    return { platform, verb, categories, facts, content: [command] };
  }
  if (toolName === 'computer.install_packages') {
    const packages = Array.isArray(input['packages']) ? input['packages'].filter((name): name is string => typeof name === 'string').slice(0, 20) : [];
    if (packages.length > 0) facts.targets = packages.map((label) => ({ kind: 'package' as const, label: label.slice(0, 160) }));
    return { platform, verb: 'install', categories: ['setup'], facts, content: packages };
  }
  if (toolName === 'agent_create' || toolName === 'agent_update' || toolName === 'conversation_create') {
    const label = str(input, 'name') || str(input, 'title');
    if (label !== '') facts.targets = [{ kind: 'agent', label: label.slice(0, 160) }];
    return { platform: JUNO, verb: 'change', categories: ['setup'], facts, content: [] };
  }
  if (toolName === 'space_publish' || toolName === 'artifact_publish') {
    return { platform: JUNO, verb: 'publish', categories: ['public'], facts: { audience: { kind: 'public', recipients: [], source: 'verified' }, reversible: { value: 'yes', how: 'You can unpublish it', source: 'verified' } }, content: [] };
  }
  if (toolName === 'post_to_room' || toolName === 'send_message' || toolName === 'send_file') {
    verb = 'send';
    platform = JUNO;
    categories.push('speaking');
    return { platform, verb, categories, facts, content: [str(input, 'text') || str(input, 'message') || str(input, 'path')] };
  }
  return { platform, verb, categories, facts, content: [] };
}
