/**
 * Tool policy decisions (PH7). Before any effect the harness asks these functions whether a call is
 * allowed, must be approved, or is refused, from the built-in rule table below, the account's
 * configured action rules, the per-tool plugin permissions and the names the agent is actually
 * exposed to. The strictest source wins. A call no source mentions runs (BACKEND 8.0). A run a stranger woke (not the owner) is
 * also held to a short allowlist of tools that run without asking (decision/stranger.ts, BACKEND 8.0b).
 */
import type { Doc, ListQuery, Store, Tool, ToolOrigin, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { type Connection, type PermissionTiers, type Plugin, type Rule, type ToolPermission } from '@agent-desktop/public-contracts';
import type { ChildRun } from '../../../modules/tasks/childRead.js';
import { childRunIdOfSession } from '../../execution-owner.js';
import { targetsPrivateNetwork } from '../../../modules/tools/net/addressGuard.js';
import type { RestatePromise } from '@agent-desktop/durable';
import type { ToolRunContext } from './replay.js';
import { refusal } from './tool-projection.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import { sentenceOf } from './decision/approval-arg.js';
import { matchDelegation, NO_USAGE, readDelegationUsage, relaxableByOldRules, type DelegationUsage } from './decision/delegation.js';
import { deriveDecision, type Derived } from './decision/derive.js';
import { toolPhrase } from './decision/humanize.js';
import { MAC_APP_WRITE_TOOLS } from '../../../modules/tools/tools/macApps.js';
import { PHONE_WRITE_TOOLS } from '../../../modules/tools/tools/phoneTools.js';
import { MAC_COMMAND_TOOLS, MAC_DESKTOP_TOOLS, MAC_PATH_TOOLS, SANDBOX_SCREEN_TOOLS, copyPathsOutsideMac, insideMacFolder, macAppName, usesMac, wantsForeground } from './decision/mac.js';
import { macAppAllowed, macAppKey } from '../../../modules/mac-apps.js';
import { DELETE, INSTALL, PURCHASE } from './decision/patterns.js';
import { activePageUrl } from '../../../modules/tools/computer/purchase.js';
import { chatHash, findChatByHash } from '../../../modules/chat-folder.js';
import { STRANGER_RULE_ID, folderHashOf, isStrangerWake, speakerNameOf, strangerBriefOf, strangerOf, strangerReason, strangerScope, type ChatPolicy } from './decision/stranger.js';
import { readOwnerTimeZone } from '../../brain/context.js';
import {
  DRAFT_NOTICE, SCHEDULE_CHANGE_TOOLS, hiddenInScope, offeredIn, pathRefusal, presentToolScope, recipientsOf, scheduleRefusal, sendsToOthers, type ToolScope,
} from '../../../modules/tools/scope.js';

/** The run context plus the awakeable an approval wait needs; the core passes a full RunContext. */
export interface ToolCallContext extends ToolRunContext {
  awakeable?<T>(): { id: string; promise: RestatePromise<T> };
  drainInbox?(): RestatePromise<WakeEvent[]>;
}

export type ToolPolicyVerdict =
  /** `delegationId`: the call was allowed by a delegation (not by the absence of any rule), so the harness records the decision. */
  | { kind: 'allow'; delegationId?: string }
  | { kind: 'ask'; reason: string; ruleId?: string }
  | { kind: 'deny'; reason: string; ruleId?: string }
  | { kind: 'handoff'; reason: string; ruleId?: string };

/** `approved` records that this call went through the durable approval, so an `ask` is satisfied. */
export type ToolAuthorization =
  | { kind: 'allow'; approved: boolean }
  | { kind: 'refuse'; result: ToolResult }
  | { kind: 'cancelled' };

export interface ToolPolicyConfig {
  exposed: ReadonlySet<string>;
  rules: readonly Rule[];
  plugins: readonly Plugin[];
  /** Plugin ids whose configured connection is not connected; their tools are refused. */
  disconnectedPluginIds: ReadonlySet<string>;
  /** True when the configured set could not be read in full; every effect is then refused. */
  unreadable: boolean;
  /** The agent's permission tiers; absent or a missing key is the default. */
  tiers?: PermissionTiers;
  /** The agent this config was read for: a delegation belongs to one agent. */
  agentId?: string;
  /** The MCP tools the agent is exposed to by name: where each comes from (connection, catalog entry, the server's own tool name). */
  origins?: ReadonlyMap<string, ToolOrigin>;
  /** The page the agent is on (URL), for the host of a browser action's brief. */
  pageUrl?: string;
  /** The page last seen through the owner's Mac; never filled from the sandbox cache. */
  macPageUrl?: string;
  /** This month's approved requests of the agent: the spend and per-day counts delegation limits are checked against. */
  usage?: DelegationUsage;
  /** The owner's time zone, the default for the window a "committing" delegation starts with. */
  ownerTimeZone?: string;
  /** The agent may use the owner's Mac (My Mac). A call that names the Mac without it is refused; with it, commands and anything outside ~/Juno ask first. */
  macAccess?: boolean;
  /** The chat of a run a stranger woke (BACKEND 8.0b); absent for a run the owner woke. */
  chat?: ChatPolicy;
  /** Who is present in the run right now (batch 5b): a tool hidden for that presence is refused whatever the frozen list said. */
  scope?: { kind: ToolScope; conversationId: string; scheduleOwn?: boolean; hidden?: ReadonlySet<string> };
}

/** The brief of a call under this config; one place so authorization, the fresh check and the card agree. */
export function deriveFor(config: Pick<ToolPolicyConfig, 'origins' | 'pageUrl' | 'macPageUrl' | 'chat'>, toolName: string, args: unknown, wake?: WakeEvent): Derived {
  const origin = config.origins?.get(toolName);
  const mac = usesMac(toolName, args);
  const pageUrl = mac ? config.macPageUrl : config.pageUrl;
  const stranger = strangerOf(config, wake) === undefined ? undefined : strangerBriefOf(strangerScope(config, wake, toolName, args));
  const macApp = MAC_DESKTOP_TOOLS.has(toolName) ? { app: macAppKey(stringArg(args, 'app')), name: macAppName(args), purpose: wantsForeground(toolName, args) ? 'foreground' as const : 'use' as const } : undefined;
  return deriveDecision({
    toolName, args,
    ...(macApp === undefined ? {} : { macApp }),
    ...(origin === undefined ? {} : { origin }),
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(mac ? { mac: true } : {}),
    ...(stranger === undefined ? {} : { stranger }),
  });
}

/** Strictest first: an explicit hand-off or block always beats a looser configured level. */
const RULE_RANK: Record<Rule['behavior'], number> = { auto: 0, on_command: 1, ask: 2, handoff: 3 };
/** Most restrictive wins across several configured plugin tools with the same name. */
const PERMISSION_RANK: Record<ToolPermission, number> = { always: 0, ask: 1, never: 2 };

/**
 * The rule for one tool. `rules` already holds only this owner's rules for this agent (readToolPolicyConfig), so a
 * rule with an `agentId` is the more specific one (BACKEND 8.2): it wins over an owner-wide rule for the same tool,
 * and within the same specificity the strictest wins.
 */
function exactActionRule(rules: readonly Rule[], toolName: string): Rule | undefined {
  let chosen: Rule | undefined;
  for (const rule of rules) {
    if (!rule.enabled || rule.scope !== 'action' || rule.subject !== toolName) continue;
    if (chosen === undefined) {
      chosen = rule;
    } else if ((rule.agentId !== undefined) !== (chosen.agentId !== undefined)) {
      if (rule.agentId !== undefined) chosen = rule;
    } else if (RULE_RANK[rule.behavior] > RULE_RANK[chosen.behavior]) {
      chosen = rule;
    }
  }
  return chosen;
}

function pluginPermission(plugins: readonly Plugin[], toolName: string): ToolPermission | undefined {
  let found: ToolPermission | undefined;
  for (const plugin of plugins) {
    if (!plugin.installed) continue;
    for (const tool of plugin.tools) {
      if (tool.name !== toolName) continue;
      if (found === undefined || PERMISSION_RANK[tool.permission] > PERMISSION_RANK[found]) found = tool.permission;
    }
  }
  return found;
}

/** The first installed plugin that exposes this tool name, for its connection state. */
function pluginFor(plugins: readonly Plugin[], toolName: string): Plugin | undefined {
  return plugins.find((plugin) => plugin.installed && plugin.tools.some((tool) => tool.name === toolName));
}

/**
 * Built-in rules (BACKEND 8.0): an ordered table in code, not stored, so no user rule or standing
 * grant can relax them. Each matches on the arguments the model actually sent, so a call whose
 * arguments carry no readable text (a click by ref or by coordinates) matches none of them.
 */
interface BuiltinRule {
  id: string;
  behavior: 'ask' | 'handoff' | 'deny';
  reason: string;
  /** The reason the user reads, when the call itself says better (the agent's own `confirm` sentence). */
  reasonFor?(args: unknown, toolName: string): string;
  matches(toolName: string, args: unknown, config?: ToolPolicyConfig): boolean;
}

function stringArg(args: unknown, key: string): string {
  if (typeof args !== 'object' || args === null) return '';
  const value: unknown = Reflect.get(args, key);
  return typeof value === 'string' ? value : '';
}

const URL_TOOLS: ReadonlySet<string> = new Set(['browser.navigate', 'browser.new_tab', 'web_fetch']);

/** Whether a call opens a URL: navigate and fetch always do, a new tab only when given one. */
function opensUrl(toolName: string, args: unknown): boolean {
  return URL_TOOLS.has(toolName) && (toolName !== 'browser.new_tab' || stringArg(args, 'url') !== '');
}

/** The one string of a call that a keyword rule reads: a shell command or a URL; '' for other tools. */
function readableText(toolName: string, args: unknown): string {
  if (toolName === 'shell.run' || toolName === 'shell.start') return stringArg(args, 'command');
  return opensUrl(toolName, args) ? stringArg(args, 'url') : '';
}

/** What the owner reads on the card for a change in Mail, Calendar, Reminders or Notes: a send names its recipients and subject. */
function macAppsReason(toolName: string, args: unknown): string {
  const list = (key: string): string => {
    const value: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, key) : undefined;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(', ') : '';
  };
  const subject = stringArg(args, 'subject').slice(0, 120);
  if (toolName === 'mac_mail_send') return `Send an email from your Mac to ${list('to').slice(0, 160)}${list('cc') === '' ? '' : ` (cc ${list('cc').slice(0, 160)})`}: "${subject}"`;
  if (toolName === 'mac_mail_create_draft') return `Save an email draft on your Mac to ${list('to').slice(0, 160)}: "${subject}"`;
  if (toolName === 'mac_calendar_create_event') return `Add to your Calendar: "${stringArg(args, 'title').slice(0, 120)}" at ${stringArg(args, 'start').slice(0, 40)}`;
  if (toolName === 'mac_reminders_create') return `Add to your Reminders: "${stringArg(args, 'title').slice(0, 120)}"`;
  if (toolName === 'mac_notes_create') return `Create a note on your Mac: "${stringArg(args, 'title').slice(0, 120)}"`;
  if (toolName === 'mac_notes_append') return 'Add text to a note on your Mac';
  return 'Mark a reminder done on your Mac';
}

/** What the owner reads on the card for a change to Calendar or Reminders on the iPhone. */
function phoneReason(toolName: string, args: unknown): string {
  const title = stringArg(args, 'title').slice(0, 120);
  const when = (value: string): string => (value === '' ? '' : ` at ${value.slice(0, 40)}`);
  const series = stringArg(args, 'span') === 'future' ? ' (this and all later ones in the series)' : '';
  if (toolName === 'phone_calendar_create_event') return `Add to your iPhone calendar: "${title}"${when(stringArg(args, 'start'))}`;
  if (toolName === 'phone_calendar_update_event') return `Change an event on your iPhone calendar${title === '' ? '' : `: "${title}"`}${series}`;
  if (toolName === 'phone_calendar_delete_event') return `Delete an event from your iPhone calendar${series}`;
  if (toolName === 'phone_reminders_create') return `Add to your iPhone reminders: "${title}"${when(stringArg(args, 'due'))}`;
  if (toolName === 'phone_reminders_update') return 'Change a reminder on your iPhone';
  return 'Delete a reminder on your iPhone';
}

function keyword(pattern: RegExp): BuiltinRule['matches'] {
  return (toolName, args) => pattern.test(readableText(toolName, args));
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index]);
    sum += index % 2 === 1 ? (digit * 2 > 9 ? digit * 2 - 9 : digit * 2) : digit;
  }
  return sum % 10 === 0;
}

/** Typed text that is a card number: the field kind is not in the arguments, the digits are. */
/** Texts a typing tool would put on the page: `text`, or each field of browser.fill. */
function typedTexts(toolName: string, args: unknown): string[] {
  if (toolName === 'browser.type' || toolName === 'computer.type') return [stringArg(args, 'text')];
  if (toolName !== 'browser.fill' || typeof args !== 'object' || args === null) return [];
  const fields: unknown = Reflect.get(args, 'fields');
  return Array.isArray(fields) ? fields.map((field) => stringArg(field, 'text')) : [];
}

function typesCardNumber(toolName: string, args: unknown): boolean {
  return typedTexts(toolName, args).some((text) => {
    const candidates = text.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? [];
    return candidates.some((candidate) => luhnValid(candidate.replace(/[ -]/g, '')));
  });
}


const CHANGE_PASSWORD = /\b(passwd|chpasswd)\b|(change|reset)[-_/ ]?password|password[-_/ ]?(change|reset)/i;
const AGENT_ADMIN_TOOLS: ReadonlySet<string> = new Set(['agent_create', 'agent_update', 'conversation_create']);

/** Ordered; a tie in strictness goes to the earlier rule, so the audit names the first match. */
const BUILTIN_RULES: readonly BuiltinRule[] = [
  {
    id: 'builtin.handoff',
    behavior: 'handoff',
    reason: 'Card numbers and passwords are typed by the user, not the agent: for a page field call request_secure_input with its ref (the user types the value straight into the page); a password change outside a web page is for the user to do',
    matches: (toolName, args) => typesCardNumber(toolName, args) || keyword(CHANGE_PASSWORD)(toolName, args),
  },
  {
    id: 'builtin.private-network',
    behavior: 'deny',
    reason: 'Opening local or private network addresses is blocked',
    matches: (toolName, args) => opensUrl(toolName, args) && targetsPrivateNetwork(stringArg(args, 'url')),
  },
  {
    // The owner has not allowed this agent on the Mac (or has no Mac paired): the call is refused before anyone is asked.
    id: 'builtin.mac-off',
    behavior: 'deny',
    reason: 'This agent has no access to your Mac. Use the sandbox (on: "sandbox"), or ask the user to allow Mac access for this agent in its settings.',
    matches: (toolName, args, config) => usesMac(toolName, args) && config?.macAccess !== true,
  },
  {
    // The coordinate screen tools are sandbox-only now: on the Mac an app is worked with snapshot / act / verify.
    id: 'builtin.mac-screen-moved',
    behavior: 'deny',
    reason: 'Screenshots and clicks do not work on the Mac any more: use computer.snapshot to read an app, computer.act to click, type or press keys in it, and computer.verify to check the result.',
    matches: (toolName, args) => SANDBOX_SCREEN_TOOLS.has(toolName) && usesMac(toolName, args),
  },
  {
    // An app is brought to the front only when the owner says so, each time (cua-driver works in the background by default).
    id: 'builtin.mac-foreground',
    behavior: 'ask',
    reason: 'The app needs to come to the front for this',
    reasonFor: (args) => `${macAppName(args)} needs to come to the front for this. OK?`,
    matches: (toolName, args) => wantsForeground(toolName, args),
  },
  {
    // The first use of an app on the Mac asks (Allow once / Always allow / Don't allow); reading its window counts as using it.
    id: 'builtin.mac-app',
    behavior: 'ask',
    reason: 'The agent wants to use an app on your Mac',
    reasonFor: (args) => `Use ${macAppName(args)} on your Mac`,
    matches: (toolName, args, config) => MAC_DESKTOP_TOOLS.has(toolName) && !macAppAllowed(config?.rules ?? [], stringArg(args, 'app')),
  },
  {
    id: 'builtin.mac-command',
    behavior: 'ask',
    reason: 'The agent wants to run a command on your Mac',
    reasonFor: (args) => 'Run on your Mac: ' + (stringArg(args, 'command').trim().split('\n')[0] ?? '').slice(0, 160),
    matches: (toolName, args) => MAC_COMMAND_TOOLS.has(toolName) && usesMac(toolName, args),
  },
  {
    // Mail, Calendar and Reminders on the Mac: reads are free, every change asks each time, and "always allow" cannot loosen it.
    id: 'builtin.mac-apps',
    behavior: 'ask',
    reason: 'The agent wants to change something in Mail, Calendar or Reminders on your Mac',
    reasonFor: (args, toolName) => macAppsReason(toolName, args),
    matches: (toolName) => MAC_APP_WRITE_TOOLS.has(toolName),
  },
  {
    // Calendar and Reminders on the iPhone: reads are free, every change asks each time.
    id: 'builtin.phone-write',
    behavior: 'ask',
    reason: 'The agent wants to change your calendar or reminders on your iPhone',
    reasonFor: (args, toolName) => phoneReason(toolName, args),
    matches: (toolName) => PHONE_WRITE_TOOLS.has(toolName),
  },
  {
    id: 'builtin.mac-outside',
    behavior: 'ask',
    reason: 'The agent wants to use a file outside your Juno folder on your Mac',
    reasonFor: (args) => 'Use a file outside ~/Juno on your Mac: ' + stringArg(args, 'path').slice(0, 160),
    matches: (toolName, args) => MAC_PATH_TOOLS.has(toolName) && usesMac(toolName, args) && !insideMacFolder(stringArg(args, 'path')),
  },
  {
    id: 'builtin.mac-audio',
    behavior: 'ask',
    reason: "The agent wants to start recording system audio on your Mac",
    matches: (toolName, args) => toolName === 'computer.record_audio' && usesMac(toolName, args) && stringArg(args, 'action') === 'start',
  },
  {
    id: 'builtin.mac-copy',
    behavior: 'ask',
    reason: 'The agent wants to copy a file to or from outside your Juno folder on your Mac',
    reasonFor: (args) => 'Copy ' + copyPathsOutsideMac(args).join(' and ').slice(0, 160) + ' on your Mac (outside ~/Juno)',
    matches: (toolName, args) => toolName === 'computer_copy' && copyPathsOutsideMac(args).length > 0,
  },
  { id: 'builtin.delete', behavior: 'ask', reason: 'This looks like a permanent delete', matches: keyword(DELETE) },
  { id: 'builtin.install', behavior: 'ask', reason: 'This installs software or runs a downloaded script', matches: keyword(INSTALL) },
  {
    // The agent user has no sudo (BACKEND 7.9): system packages are installed by the platform as root, only with the user's OK.
    id: 'builtin.install-packages',
    behavior: 'ask',
    reason: 'The agent wants to install system packages',
    reasonFor: (args) => {
      const packages: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'packages') : undefined;
      const names = Array.isArray(packages) ? packages.filter((name): name is string => typeof name === 'string').join(', ') : '';
      const why = stringArg(args, 'reason').trim();
      return 'Install system packages' + (names === '' ? '' : ': ' + names) + (why === '' ? '' : ' (' + why + ')');
    },
    matches: (toolName) => toolName === 'computer.install_packages',
  },
  {
    id: 'builtin.confirm',
    behavior: 'ask',
    reason: 'The agent marked this action as needing your OK',
    reasonFor: (args) => sentenceOf(args),
    // An MCP tool's `approval` is its brief, not a request to stop (its default ask and delegations decide); a native tool's is the same as `confirm`.
    matches: (toolName, args, config) => (config?.origins?.has(toolName) === true ? stringArg(args, 'confirm').trim() !== '' : sentenceOf(args) !== ''),
  },
  {
    id: 'builtin.agent-admin',
    behavior: 'ask',
    reason: 'Creating or changing an agent or room needs your approval',
    // An agent naming itself or writing its one-line role (the onboarding setup) is not an administrative change; its persona still is.
    matches: (toolName, args, config) => AGENT_ADMIN_TOOLS.has(toolName) && !(toolName === 'agent_update' && stringArg(args, 'id') === config?.agentId && Object.keys(args ?? {}).every((key) => key === 'id' || key === 'name' || key === 'description')),
  },
];

/**
 * Whether the user has already relaxed an MCP tool: a read tool never asks; the app's Actions policy for this agent is Allow,
 * the tool is set to always allow, an auto rule on the tool, or a standing `recipient` grant covering every recipient the call
 * names. Only this external-send default can be relaxed; the table above never is. The agent's `send: 'always'` tier lifts the
 * same default. Allow, old per-tool rules, recipient grants and the send tier never lift it for money, deleting for good or
 * secrets (decision brief categories, BACKEND 8.0): those are decided by a delegation or by the owner each time.
 */
function mcpRelaxed(config: ToolPolicyConfig, toolName: string, permission: ToolPermission | undefined, args: unknown, derive: () => Derived): boolean {
  const origin = config.origins?.get(toolName);
  // A tool the owner has not reviewed (new, or its annotations changed) asks first, whatever relaxed the app's other tools.
  if (origin?.needsReview === true) return false;
  if (permission === 'always') return true;
  if (origin?.access === 'read') return true;
  if (origin?.actions === 'allow') return relaxableByOldRules(derive());
  if (config.tiers?.send === 'always') return relaxableByOldRules(derive());
  if (exactActionRule(config.rules, toolName)?.behavior === 'auto') return relaxableByOldRules(derive());
  const recipients = recipientsOf(args);
  if (recipients.length === 0) return false;
  const granted = new Set(
    config.rules
      .filter((rule) => rule.enabled && rule.scope === 'recipient' && rule.behavior === 'auto')
      .map((rule) => (rule.subject ?? '').trim().toLowerCase()),
  );
  return recipients.every((recipient) => granted.has(recipient)) && relaxableByOldRules(derive());
}

/** Only a trusted, live user instruction satisfies `on_command`; a peer or routine is never enough. */
export function isUserCommand(wake: WakeEvent | undefined): boolean {
  return wake !== undefined && wake.trusted === true && wake.origin.type === 'user';
}

/**
 * Batch 5b: a tool hidden for who is present now (or a file outside the chat's own folder outside an owner-only chat) is refused
 * at the call, whatever the frozen list offered. Undefined when the config carries no scope or the call is allowed.
 */
function scopeRefusal(config: ToolPolicyConfig, toolName: string, args: unknown): string | undefined {
  if (config.scope === undefined) return undefined;
  const { kind, conversationId, scheduleOwn, hidden } = config.scope;
  const origin = config.origins?.get(toolName);
  // The hidden set comes from the run's exposed tools (connected apps and plugins included); without one, judge by name and origin.
  const isHidden = hidden !== undefined ? hidden.has(toolName) : hiddenInScope(kind, { name: toolName, ...(origin === undefined ? {} : { origin }) });
  if (isHidden) {
    return 'Tool ' + toolName + ' is not available in this chat, so it was not run';
  }
  const schedule = scheduleRefusal(kind, toolName, scheduleOwn === true);
  if (schedule !== undefined) return schedule + ', so it was not run';
  return pathRefusal(kind, conversationId, toolName, args);
}

/**
 * The line the approval card carries for a send to someone other than the owner, in a run only the owner is in (batch 5b): the
 * owner should check that what the agent drafted from private memory holds nothing private. Undefined otherwise.
 */
export function draftNoticeOf(config: Pick<ToolPolicyConfig, 'scope' | 'origins'>, toolName: string, args: unknown): string | undefined {
  if (config.scope?.kind !== 'owner') return undefined;
  return sendsToOthers(toolName, args, config.origins?.get(toolName), config.scope.conversationId) ? DRAFT_NOTICE : undefined;
}

export function evaluateToolPolicy(config: ToolPolicyConfig, toolName: string, wake: WakeEvent | undefined, args?: unknown): ToolPolicyVerdict {
  if (config.unreadable) {
    return { kind: 'deny', reason: 'Tool policy could not be read in full, so no tool was run' };
  }
  const hidden = scopeRefusal(config, toolName, args);
  if (hidden !== undefined) return { kind: 'deny', reason: hidden };
  if (!config.exposed.has(toolName)) {
    return { kind: 'deny', reason: 'Tool ' + toolName + ' is not exposed to this agent' };
  }
  const plugin = pluginFor(config.plugins, toolName);
  if (plugin !== undefined && config.disconnectedPluginIds.has(plugin.id)) {
    return { kind: 'deny', reason: 'The connection for ' + toolName + ' is not connected' };
  }
  const permission = pluginPermission(config.plugins, toolName);
  if (permission === 'never') return { kind: 'deny', reason: 'Plugin permission denies ' + toolName };
  const rule = exactActionRule(config.rules, toolName);
  let derived: Derived | undefined;
  const derive = (): Derived => (derived ??= deriveFor(config, toolName, args, wake));
  const phrase = toolPhrase(toolName, config.origins?.get(toolName), usesMac(toolName, args));
  // Strictest wins across ALL sources, built-ins first so a tie names the built-in rule. A permissive
  // rule (`auto`) must never license an effect the plugin permission or a built-in rule asks about,
  // and an `ask` rule must not be loosened by an `always` permission.
  const candidates: Array<{ weight: number; decide: () => ToolPolicyVerdict }> = [];
  let delegationId: string | undefined;
  // A stranger's ask comes first, so a tie with another ask names who asked and where (the card's reason), not only what.
  const stranger = strangerOf(config, wake);
  if (stranger !== undefined) {
    const scope = strangerScope(config, wake, toolName, args);
    // A file of another chat is let through by the owner's sharing delegation (source chat -> this chat) and nothing else.
    const shared = scope.kind === 'share' ? matchDelegation(derive(), config.agentId ?? '', { rules: config.rules, usage: config.usage ?? NO_USAGE, wake, now: new Date() }) : undefined;
    if (shared !== undefined) delegationId = shared.id;
    else if (scope.kind !== 'free') {
      const reason = strangerReason(config, stranger.name, phrase, scope);
      candidates.push({ weight: STRICTNESS.ask, decide: () => ({ kind: 'ask', reason, ruleId: STRANGER_RULE_ID }) });
    }
  }
  for (const builtin of BUILTIN_RULES) {
    if (!builtin.matches(toolName, args, config)) continue;
    const reason = builtin.reasonFor?.(args, toolName) || builtin.reason;
    candidates.push({ weight: STRICTNESS[builtin.behavior], decide: () => ({ kind: builtin.behavior, reason, ruleId: builtin.id }) });
  }
  if (config.origins?.has(toolName) === true && !mcpRelaxed(config, toolName, permission, args, derive)) {
    // A delegation lifts only this default ask (never a built-in rule, a tier or a rule that asks): the owner handed this kind of decision to the agent.
    // Not for a tool nobody has reviewed: what a delegation was given for is a kind of decision the owner knew.
    const unreviewed = config.origins?.get(toolName)?.needsReview === true;
    const delegation = unreviewed ? undefined : matchDelegation(derive(), config.agentId ?? '', { rules: config.rules, usage: config.usage ?? NO_USAGE, wake, now: new Date() });
    if (delegation !== undefined) delegationId = delegation.id;
    else {
      const app = config.origins?.get(toolName)?.connectionName ?? 'a connected app';
      candidates.push({
        weight: STRICTNESS.ask,
        decide: () => ({ kind: 'ask', reason: unreviewed ? app + ' has a new or changed tool you have not reviewed yet, so it asks first' : 'Actions in ' + app + ' ask first until you allow them', ruleId: 'builtin.mcp' }),
      });
    }
  }
  const tier = tierVerdict(config.tiers, toolName, config.origins?.has(toolName) === true, args, derive);
  if (tier !== undefined) candidates.push({ weight: STRICTNESS[tier.kind], decide: () => tier });
  if (permission === 'ask') {
    candidates.push({ weight: STRICTNESS.ask, decide: () => ({ kind: 'ask', reason: 'Your settings ask before you ' + phrase }) });
  }
  if (rule !== undefined) {
    candidates.push({ weight: STRICTNESS[ruleBehaviorVerdict(rule, wake)], decide: () => ruleDecision(rule, phrase, wake) });
  }
  if (candidates.length === 0) return delegationId === undefined ? { kind: 'allow' } : { kind: 'allow', delegationId };
  return candidates.reduce((strictest, candidate) => (candidate.weight > strictest.weight ? candidate : strictest)).decide();
}

/**
 * The agent's permission tiers as one stricter-than-default verdict, if any. A tier can only tighten a call: the
 * relaxing side (`send: 'always'`) lives in mcpRelaxed and reaches nothing but the MCP default. `browsing: 'loose'`
 * behaves like 'normal' because nothing in the browser is safe to relax.
 */
function tierVerdict(tiers: PermissionTiers | undefined, toolName: string, isMcp: boolean, args: unknown, derive: () => Derived): ToolPolicyVerdict | undefined {
  if (tiers === undefined) return undefined;
  // `send: never` is a ban on speaking for the owner: by the kind of decision (speaking, public), not only when a recipient can be read out of the arguments.
  const speaks = (): boolean => derive().brief.categories.some((category) => category === 'speaking' || category === 'public');
  if (tiers.send === 'never' && isMcp && (recipientsOf(args).length > 0 || speaks())) {
    return { kind: 'deny', reason: 'This agent is not allowed to send to anyone', ruleId: 'tier.send' };
  }
  // The kind of decision (spending: a verified amount, a payment tool or the agent's purchase sentence), not a keyword match on one string.
  if (tiers.purchase === 'never' && (PURCHASE.test(sentenceOf(args)) || derive().brief.categories.includes('spending'))) {
    return { kind: 'deny', reason: 'This agent is not allowed to make purchases or payments', ruleId: 'tier.purchase' };
  }
  if (tiers.browsing === 'strict' && opensUrl(toolName, args)) {
    return { kind: 'ask', reason: 'This agent asks before opening any page', ruleId: 'tier.browsing' };
  }
  if (tiers.reachOut === 'off' && (toolName === 'suggest' || toolName === 'feed_post')) {
    return { kind: 'deny', reason: 'This agent is not allowed to make suggestions or post on its own', ruleId: 'tier.reachOut' };
  }
  return undefined;
}

/** The four levels reduced to the strictness they demand of one call. */
const STRICTNESS = { allow: 0, ask: 1, handoff: 2, deny: 3 };

type Strictness = keyof typeof STRICTNESS;

function ruleBehaviorVerdict(rule: Rule, wake: WakeEvent | undefined): Strictness {
  if (rule.behavior === 'auto') return 'allow';
  if (rule.behavior === 'ask') return 'ask';
  if (rule.behavior === 'handoff') return 'handoff';
  return isUserCommand(wake) ? 'allow' : 'deny';
}

function ruleDecision(rule: Rule, phrase: string, wake: WakeEvent | undefined): ToolPolicyVerdict {
  const verdict = ruleBehaviorVerdict(rule, wake);
  if (verdict === 'allow') return { kind: 'allow' };
  if (verdict === 'ask') return { kind: 'ask', reason: 'A rule asks before you ' + phrase, ruleId: rule.id };
  if (verdict === 'handoff') return { kind: 'handoff', reason: 'A rule hands this back to you: ' + phrase, ruleId: rule.id };
  return { kind: 'deny', reason: 'A rule allows this only on your direct instruction: ' + phrase, ruleId: rule.id };
}

const CONFIG_PAGE = 200;
/** Bounded read: a config set larger than this is treated as unreadable rather than half-seen. */
const CONFIG_MAX_PAGES = 10;

async function listAll<C extends 'rules' | 'plugins' | 'connections'>(store: Store, collection: C): Promise<Array<Doc<C>> | null> {
  const items: Array<Doc<C>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < CONFIG_MAX_PAGES; page += 1) {
    const query: ListQuery = { limit: CONFIG_PAGE, ...(cursor === undefined ? {} : { cursor }) };
    const result = await store.list(collection, query);
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    cursor = result.nextCursor;
  }
  return null;
}

/**
 * A plugin stores an MCP tool under the server's own name, but the model (and so the policy) sees
 * `<connector>_<name>`. Add the model-visible name beside the stored one (read off the exposed tools' origins) so the
 * plugin's ask, never and disconnected state apply to the tool the model actually calls.
 */
function withMcpToolNames(plugin: Plugin, connections: readonly Connection[], exposedTools: readonly Tool[]): Plugin {
  const mcp = connections.filter((connection) => connection.pluginId === plugin.id && connection.kind === 'mcp');
  if (mcp.length === 0) return plugin;
  const aliases = mcp.flatMap((connection) => plugin.tools.flatMap((tool) => {
    const exposed = exposedTools.find((candidate) => candidate.origin?.connectionId === connection.id && candidate.origin.toolName === tool.name);
    return exposed === undefined ? [] : [{ ...tool, name: exposed.name }];
  }));
  return { ...plugin, tools: [...plugin.tools, ...aliases] };
}

/** The call and the run around it, for the part of the config that depends on who woke the run and which file is named. */
export interface PolicyCall {
  conversationId: string;
  wakes: readonly WakeEvent[];
  toolName: string;
  args: unknown;
}

export function policyCallOf(input: Pick<RunInput, 'conversationId' | 'wakeEvents'>, toolName: string, args: unknown): PolicyCall {
  return { conversationId: input.conversationId, wakes: input.wakeEvents, toolName, args };
}

/**
 * The chat a stranger-woken run is in (BACKEND 8.0b), or undefined when no wake of the run is a stranger's: its title for the card's
 * reason and, when the call names a file in another chat's folder, that chat (found by the hash in the folder name).
 */
async function readChatPolicy(store: Store, ownerId: string, call: PolicyCall): Promise<ChatPolicy | undefined> {
  const wake = call.wakes.find((candidate) => isStrangerWake(candidate));
  if (wake === undefined) return undefined;
  const conversation = await store.get('conversations', call.conversationId).catch(() => null);
  const hash = folderHashOf(call.toolName, call.args);
  const other = hash === undefined || hash === chatHash(call.conversationId) ? null : await findChatByHash(store, hash, ownerId === '' ? undefined : ownerId).catch(() => null);
  const name = speakerNameOf(wake);
  return {
    conversationId: call.conversationId,
    ...(conversation?.title === undefined ? {} : { title: conversation.title }),
    stranger: name === undefined ? {} : { name },
    ...(other === null ? {} : { other }),
  };
}

/** Who is present in this call's run right now (batch 5b): the owner alone, a group, or anyone else (an unknown owner counts as anyone else). */
async function presentScope(store: Store, ownerId: string, agentId: string, call: PolicyCall, exposed: readonly Tool[]): Promise<NonNullable<ToolPolicyConfig['scope']>> {
  const kind = await presentToolScope(store, { ownerId: ownerId === '' ? undefined : ownerId, agentId, conversationId: call.conversationId, wake: [...call.wakes] });
  const hidden = new Set(exposed.filter((tool) => hiddenInScope(kind, tool)).map((tool) => tool.name));
  // A schedule change outside the owner's chat is allowed only for an item this chat made (its record names the conversation).
  const scheduleOwn = kind !== 'owner' && SCHEDULE_CHANGE_TOOLS.has(call.toolName) ? await scheduleItemInChat(store, agentId, call) : undefined;
  return { kind, conversationId: call.conversationId, hidden, ...(scheduleOwn === undefined ? {} : { scheduleOwn }) };
}

async function scheduleItemInChat(store: Store, agentId: string, call: PolicyCall): Promise<boolean> {
  const id = typeof call.args === 'object' && call.args !== null ? Reflect.get(call.args, 'id') : undefined;
  if (typeof id !== 'string') return false;
  const item = await store.get('agentCalendar', id).catch(() => null);
  return item !== null && item.agentId === agentId && item.conversationId === call.conversationId;
}

/** Read this call's policy inputs fresh: exposed names, the owner's rules, the agent's plugins. */
export async function readToolPolicyConfig(
  store: Store,
  registry: RunServices['toolRegistry'],
  agentId: string,
  ownerId: string,
  signal?: AbortSignal,
  call?: PolicyCall,
): Promise<ToolPolicyConfig> {
  // The signal lets an MCP discovery abort with the run instead of holding a stop for up to 30s.
  const exposedTools = await registry.forAgent(agentId, { signal });
  const exposed = new Set(exposedTools.map((tool) => tool.name));
  const origins = new Map(exposedTools.flatMap((tool) => (tool.origin === undefined ? [] : [[tool.name, tool.origin] as const])));
  const rules = await listAll(store, 'rules');
  const plugins = await listAll(store, 'plugins');
  const connections = await listAll(store, 'connections');
  if (rules === null || plugins === null || connections === null) {
    return { exposed, rules: [], plugins: [], disconnectedPluginIds: new Set(), unreadable: true };
  }
  const mine = rules.filter((rule) => (rule.createdBy === undefined || rule.createdBy === ownerId) && (rule.agentId === undefined || rule.agentId === agentId));
  const usable = plugins.filter((plugin) => plugin.usedByAgentIds.includes(agentId)).map((plugin) => withMcpToolNames(plugin, connections, exposedTools));
  const disconnected = new Set<string>();
  for (const plugin of usable) {
    const rows = connections.filter((connection) => connection.pluginId === plugin.id);
    if (rows.length > 0 && !rows.some((connection) => connection.status === 'connected')) disconnected.add(plugin.id);
  }
  const agent = await store.get('agents', agentId);
  const tiers = agent?.permissionTiers;
  const delegating = mine.some((rule) => rule.scope === 'delegation' && rule.enabled);
  // Only an agent with a delegation pays for reading its month of approvals and the owner's time zone.
  const usage = delegating ? await readDelegationUsage(store, agentId, new Date()) : undefined;
  const ownerTimeZone = await readOwnerTimeZone(store, ownerId === '' ? undefined : ownerId);
  const pageUrl = activePageUrl(agentId);
  const macPageUrl = activePageUrl(agentId, 'mac');
  const chat = call === undefined ? undefined : await readChatPolicy(store, ownerId, call);
  const scope = call === undefined ? undefined : await presentScope(store, ownerId, agentId, call, exposedTools);
  return {
    exposed, rules: mine, plugins: usable, disconnectedPluginIds: disconnected, unreadable: false, agentId, origins,
    ...(tiers === undefined ? {} : { tiers }),
    ...(usage === undefined ? {} : { usage }),
    ...(ownerTimeZone === undefined ? {} : { ownerTimeZone }),
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(macPageUrl === undefined ? {} : { macPageUrl }),
    ...(agent?.macAccess === true ? { macAccess: true } : {}),
    ...(chat === undefined ? {} : { chat }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * The tool names a child run may call (child_spawn `tools`, fixed on its row at reservation), or undefined
 * for an unrestricted run. The row is the only source, so a replay reads the same narrowing.
 */
async function childToolAllowlist(store: Store, input: RunInput): Promise<readonly string[] | undefined> {
  const childRunId = childRunIdOfSession(input.sessionKey, input.agentId, input.conversationId);
  if (childRunId === undefined) return undefined;
  const row: ChildRun | null = await store.get('runs', childRunId);
  return row?.allowedTools;
}

/**
 * A child run's view of the tool registry: only the names its child_spawn `tools` allowed are offered to
 * the model (and so to the policy's exposed set). Root runs and unrestricted children get the registry as-is.
 */
export async function scopeChildTools(ctx: Pick<RunContext, 'run'>, services: RunServices, input: RunInput): Promise<RunServices> {
  if (childRunIdOfSession(input.sessionKey, input.agentId, input.conversationId) === undefined) return services;
  const allowed = await ctx.run('child-tools', async () => (await childToolAllowlist(services.store, input)) ?? null);
  if (allowed === null) return services;
  const registry = services.toolRegistry;
  return {
    ...services,
    toolRegistry: {
      get: (name) => registry.get(name),
      // The list is small and the parent named it, so each allowed tool is presented directly, not deferred behind tool_search.
      forAgent: async (agentId, options) => (await registry.forAgent(agentId, options))
        .filter((tool) => allowed.includes(tool.name))
        .map((tool) => ({ ...tool, deferLoading: false })),
    },
  };
}

/**
 * The run's registry narrowed to its conversation's frozen tool scope (batch 5b, like scopeChildTools): the list the model is offered
 * and the policy's exposed set both come from this forAgent, so they read the same scope. A hidden tool is also refused at the call.
 */
export function scopeToolsFor(services: RunServices, scope: ToolScope | undefined): RunServices {
  const kind = scope ?? 'owner';
  const registry = services.toolRegistry;
  return {
    ...services,
    toolRegistry: {
      ...registry,
      forAgent: async (agentId, options) => offeredIn(kind, await registry.forAgent(agentId, options)),
    },
  };
}

/**
 * Re-check immediately before a new effect. A rule or connection that changed while an approval was
 * pending must still block the action; a result already cached by the replay fence is untouched
 * because the fence returns it without running the effect lambda at all.
 */
export async function freshRefusal(
  services: Pick<RunServices, 'store' | 'toolRegistry'>,
  input: RunInput,
  toolName: string,
  args: unknown,
  approved: boolean,
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  const wake = input.wakeEvents[0];
  // Narrowing only: a child may call a tool only when its parent listed it AND the agent exposes it.
  const allowed = await childToolAllowlist(services.store, input);
  if (allowed !== undefined && !allowed.includes(toolName)) return refusal('Tool ' + toolName + ' is not in the tools this child task was given');
  const config = await readToolPolicyConfig(services.store, services.toolRegistry, input.agentId, wake?.ownerId ?? '', signal, policyCallOf(input, toolName, args));
  const verdict = evaluateToolPolicy(config, toolName, wake, args);
  if (verdict.kind === 'allow') return null;
  // A call this run already put through the durable approval satisfies a still-configured `ask`.
  if (verdict.kind === 'ask') return approved ? null : refusal('Tool ' + toolName + ' now requires approval, so it was not run');
  return refusal(verdict.reason);
}
