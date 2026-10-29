import { DECISION_CATEGORY_ORDER, isDelegableCategory, primaryCategory } from '@agent-desktop/public-contracts';
import type { DecisionBrief, DecisionCategory, DecisionFacts, DecisionPlatform } from '@agent-desktop/public-contracts';
import type { ToolOrigin } from '../../../../contracts/index.js';
import { readApproval, SENTENCE_MAX, type AgentApproval } from './approval-arg.js';
import { computeBinding } from './binding.js';
import { deriveMcp } from './facts-mcp.js';
import { deriveBrowser, deriveNative, type NativeDerivation } from './facts-native.js';
import { toolWords } from './humanize.js';
import { withStranger, type StrangerBrief } from './stranger.js';

/**
 * The decision brief of one tool call, a pure function of the call and what the server knows about its surroundings (BACKEND
 * 8.1). The agent's own words fill the sentence, reason and "if denied"; the platform, the categories and the facts come from
 * the real arguments, the connection and the active page, and the agent's declarations can only add to them (stricter) or fill a
 * fact the server could not derive (marked `declared`, which no delegation ever trusts).
 */
export interface DeriveInput {
  toolName: string;
  args: unknown;
  /** Set for an MCP tool: its connection and the server's tool name. */
  origin?: ToolOrigin;
  /** The URL of the page the agent is on, for browser actions. */
  pageUrl?: string;
  /** The agent works on the owner's Mac (My Mac): its shell and file tools are named for it. */
  mac?: boolean;
  /** Someone other than the owner woke this run and this call asks the owner (BACKEND 8.0b): what it is about. */
  stranger?: StrangerBrief;
  /** The call works an app on the owner's Mac: the approval key (as the card names it), how the owner reads it, and why it asks. */
  macApp?: { app: string; name: string; purpose: 'use' | 'foreground' };
}

export type Family = 'mcp' | 'browser' | 'native';

export interface Derived {
  brief: DecisionBrief;
  family: Family;
  /** Internal verb (reply, accept, refund...): matches `replyOnly` / `acceptOnly` limits; never shown. */
  verb: string;
  /** `app:<catalogId>`, `site:<host>` or `juno`: what a delegation is keyed on. Absent for a custom connector or a bare computer. */
  platformKey?: string;
  /** What a person would call the tool: "send email" and the app it runs in. */
  action: string;
  app?: string;
  /** Whether "allow this kind" can be offered / a delegation can match, and if not, why. */
  delegable: { ok: true } | { ok: false; reason: string };
  /** A stranger's call for a file of another chat (sharing): the source chat; its delegation is keyed `chat:<chatId>`. */
  share?: { chatId: string; title: string };
  /** Set for a call that works an app on the owner's Mac; the card offers "Always allow" for `purpose: 'use'`. */
  macApp?: { app: string; name: string; purpose: 'use' | 'foreground' };
}

const BROWSER_TOOLS: ReadonlySet<string> = new Set(['computer.click', 'computer.double_click', 'computer.type', 'computer.key']);

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function platformKeyOf(platform: DecisionPlatform): string | undefined {
  if (platform.kind === 'connector') return platform.catalogId === undefined ? undefined : `app:${platform.catalogId}`;
  if (platform.kind === 'site') return platform.host === undefined ? undefined : `site:${platform.host}`;
  return platform.kind === 'juno' ? 'juno' : undefined;
}

function familyOf(input: DeriveInput): Family {
  if (input.origin !== undefined) return 'mcp';
  return input.toolName.startsWith('browser.') || BROWSER_TOOLS.has(input.toolName) ? 'browser' : 'native';
}

/** The agent's declared facts, for the parts the server could not derive. They are always `declared`. */
function withDeclared(facts: DecisionFacts, agent: AgentApproval | undefined, categories: Set<DecisionCategory>): DecisionFacts {
  if (agent === undefined) return facts;
  const merged: DecisionFacts = { ...facts };
  const declared = agent.facts;
  if (merged.money === undefined && declared.money !== undefined) {
    merged.money = { ...declared.money, source: 'declared' };
    categories.add('spending');
  }
  if (merged.audience === undefined && declared.recipients !== undefined) {
    merged.audience = { kind: 'people', recipients: declared.recipients.map((name) => ({ name })), count: declared.recipients.length, source: 'declared' };
  }
  if (merged.reversible === undefined && declared.reversible !== undefined) {
    merged.reversible = { value: declared.reversible, source: 'declared' };
    if (declared.reversible === 'no') categories.add('irreversible');
  }
  return merged;
}

function notDelegable(categories: readonly DecisionCategory[], family: Family, platform: DecisionPlatform, byAgent: boolean, stranger?: StrangerBrief): Derived['delegable'] {
  if (stranger?.kind === 'private') return { ok: false, reason: 'private files' };
  if (stranger?.kind === 'ask') return { ok: false, reason: 'Someone other than you asked, so this is asked every time' };
  if (categories.length === 0) return { ok: false, reason: 'There is no kind of decision to allow here' };
  const blocked = categories.filter((category) => !isDelegableCategory(category));
  if (blocked.length > 0) return { ok: false, reason: `${blocked.join(', ')} is asked every time and cannot be allowed in advance` };
  // A file of another chat is shared by the owner's say-so, not by what the agent wrote: the server found the source chat in the path.
  if (stranger?.kind === 'share') return { ok: true };
  if (!byAgent) return { ok: false, reason: 'The agent did not say what it wants to do' };
  if (family !== 'mcp') return { ok: false, reason: 'Only connected apps can be allowed in advance' };
  if (platform.catalogId === undefined) return { ok: false, reason: 'This connection is a custom one, so its actions cannot be checked' };
  return { ok: true };
}

export function deriveDecision(input: DeriveInput): Derived {
  const family = familyOf(input);
  const agent = readApproval(input.args);
  let platform: DecisionPlatform;
  let verb: string;
  let derivedCategories: DecisionCategory[];
  let facts: DecisionFacts;
  let content: string[];
  if (family === 'mcp' && input.origin !== undefined) {
    const mcp = deriveMcp(input.origin, input.args);
    platform = {
      kind: 'connector',
      name: input.origin.connectionName,
      ...(input.origin.catalogId === undefined ? {} : { catalogId: input.origin.catalogId }),
      ...(input.origin.account === undefined ? {} : { account: input.origin.account }),
    };
    ({ verb, facts, content } = mcp);
    derivedCategories = mcp.categories;
  } else {
    const native: NativeDerivation = family === 'browser' ? deriveBrowser(input.args, input.pageUrl) : deriveNative(input.toolName, input.args, input.mac === true);
    ({ platform, verb, facts, content } = native);
    derivedCategories = native.categories;
  }
  if (input.stranger !== undefined) {
    const extra = withStranger(input.stranger, platform, facts);
    ({ platform, facts } = extra);
    // A file of another chat is a "sharing" decision whatever the tool (publishing it is shown in this chat, not made public): the
    // owner's sharing delegation is then the only thing that has to cover it.
    derivedCategories = input.stranger.kind === 'share' ? extra.categories : [...derivedCategories, ...extra.categories];
  }
  const categories = new Set<DecisionCategory>([...derivedCategories, ...(agent?.categories ?? [])]);
  const merged = withDeclared(facts, agent, categories);
  const ordered = DECISION_CATEGORY_ORDER.filter((category) => categories.has(category));
  const words = toolWords(input.toolName, input.origin, input.mac === true);
  const share = input.stranger?.kind === 'share' ? { chatId: input.stranger.chatId, title: input.stranger.title } : undefined;
  const macApp = input.macApp;
  const fallback = macApp !== undefined
    ? (macApp.purpose === 'foreground' ? `Bring ${macApp.name} to the front` : `${capitalize(words.action)} ${macApp.name} on your Mac`)
    : words.app === undefined ? capitalize(words.action) : `${capitalize(words.action)} in ${words.app}`;
  const sentence = (agent?.sentence ?? (share === undefined ? fallback : `${fallback} from "${share.title}"`)).slice(0, SENTENCE_MAX);
  const platformKey = share === undefined ? platformKeyOf(platform) : `chat:${share.chatId}`;
  const primary = primaryCategory(ordered);
  const verified = (value: { source: string } | undefined): boolean => value?.source === 'verified';
  const brief: DecisionBrief = {
    sentence,
    sentenceSource: agent?.sentence === undefined ? 'server' : 'agent',
    ...(agent?.why === undefined ? {} : { why: agent.why }),
    ...(agent?.ifDenied === undefined ? {} : { ifDenied: agent.ifDenied }),
    categories: ordered,
    ...(primary === undefined ? {} : { primary }),
    platform,
    facts: merged,
    binding: computeBinding(input.args, content, {
      platform: platformKey ?? platform.name,
      ...(verified(merged.money) ? { money: merged.money } : {}),
      ...(verified(merged.audience) ? { recipients: merged.audience?.recipients } : {}),
      ...(verified(merged.asAccount) ? { asAccount: merged.asAccount } : {}),
      ...(merged.targets === undefined ? {} : { targets: merged.targets }),
    }),
  };
  return {
    brief,
    family,
    verb,
    ...(platformKey === undefined ? {} : { platformKey }),
    action: words.action,
    ...(words.app === undefined ? {} : { app: words.app }),
    delegable: notDelegable(ordered, family, platform, agent?.sentence !== undefined, input.stranger),
    ...(share === undefined ? {} : { share }),
    ...(macApp === undefined ? {} : { macApp }),
  };
}
