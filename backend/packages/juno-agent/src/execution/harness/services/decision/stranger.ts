import type { DecisionCategory, DecisionFacts, DecisionPlatform } from '@agent-desktop/public-contracts';
import type { WakeEvent } from '../../../../contracts/index.js';
import { chatHash, chatHashOfPath } from '../../../../modules/chat-folder.js';
import { onMac, pathOf } from '../../../../modules/tools/scope.js';

/**
 * A run woken by someone who is not the owner (a stranger in a Discord / Slack / Telegram / Feishu group) is held to a short list
 * of tools that run without asking (BACKEND 8.0b). Everything else asks the owner, with who asked and where on the card. Files are
 * the exception that can be handed on: a stranger-woken run works in its own chat's folder, a file from another chat's folder
 * needs the owner's one-time "sharing" delegation (source chat -> this chat), and anything else (`/juno`, the `/workspace` root,
 * home directories, the Mac) is private and asked every time. A run the owner woke is never held to this, in a group too.
 */

/** The `ruleId` of a stranger's ask (audit, `triggeringRuleId`, and the card's reason). */
export const STRANGER_RULE_ID = 'builtin.stranger';

/** Tools a stranger-woken run uses without asking. A well-formed `tool_call` is unwrapped to the tool it reaches before the policy sees it (brain/tool-proxy.ts); only a malformed one arrives as itself, and it does nothing. */
export const STRANGER_ALLOWED: ReadonlySet<string> = new Set([
  'web_search', 'web_fetch', 'send_message', 'react', 'todo_write', 'tool_search', 'tool_load', 'tool_call', 'skill_search', 'skill_read',
  'transcript_read', 'transcript_search', 'request_withdraw',
  // Earlier messages of the very chat the stranger is talking in: the same public chat, nothing from anywhere else.
  'channel_history',
  // Refuses itself unless the owner spoke (no approval card to the owner for a stranger's attempt).
  'group_rule',
]);

/**
 * What a teammate (a known person in a group the owner put the agent in, BACKEND 6.8) may ask on top of that: the agent's own work.
 * Child tasks, its task list and schedule, waiting, and reading what it was sent. Nothing here reaches the owner's accounts or data
 * (connectors, the Mac, private memory and files are not offered in a group at all, or ask the owner as for anyone else).
 */
export const TEAMMATE_ALLOWED: ReadonlySet<string> = new Set([
  'subagent_start', 'subagent_message', 'task_update', 'task_stop', 'tasks_list', 'read_task', 'output_read',
  'attachment_read', 'state_update', 'schedule_add', 'wait_for', 'wake_at', 'pdf_lookup',
]);

/** Tools that take a `path`: allowed inside this chat's folder, asked for anywhere else. */
export const STRANGER_PATH_TOOLS: ReadonlySet<string> = new Set(['files.read', 'files.write', 'artifact_publish']);
/** More path tools a teammate may use inside this chat's folder. */
const TEAMMATE_PATH_TOOLS: ReadonlySet<string> = new Set(['files.edit', 'files.search']);

/** What the policy knows about the chat a stranger-woken run is in (filled by `readToolPolicyConfig`, only for such a run). */
export interface ChatPolicy {
  conversationId: string;
  title?: string;
  /** Someone other than the owner woke this run: their name as the platform gave it. */
  stranger?: { name?: string };
  /** Every non-owner wake of the run is from a teammate (the ingress decided: a known person in a group that is not shared with outsiders). */
  teammate?: boolean;
  /** The kinds of decision the owner delegated to this group: a teammate's ask in one of them runs without asking the owner. */
  delegated?: readonly string[];
  /** The chat whose folder the call's `path` points into, when it is another chat's (found by the reader from the hash in the name). */
  other?: { id: string; title?: string };
}

/**
 * A user-origin wake the owner did not send: a stranger's message in a platform chat. Peer agents, routines, child tasks and system
 * wakes are not (they are not a person asking); a typing ping never runs anything.
 */
export function isStrangerWake(wake: WakeEvent | undefined): boolean {
  return wake !== undefined && wake.trusted !== true && wake.origin.type === 'user' && wake.kind !== 'typing';
}

export function speakerNameOf(wake: WakeEvent | undefined): string | undefined {
  const name = wake?.payload['speakerName'];
  return typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 80) : undefined;
}

/** Who held this run to the stranger rule, or undefined when the owner (or no one) did. */
export function strangerOf(config: { chat?: ChatPolicy }, wake: WakeEvent | undefined): { name?: string } | undefined {
  if (isStrangerWake(wake)) {
    const name = speakerNameOf(wake);
    return name === undefined ? {} : { name };
  }
  return config.chat?.stranger;
}

/** What the stranger rule says about one call. */
export type StrangerScope =
  | { kind: 'free' }
  | { kind: 'ask' }
  | { kind: 'share'; chat: { id: string; title?: string }; path: string }
  | { kind: 'private'; path: string };

/** The chat folder (its hash) a path tool's `path` points into; undefined for any other path, the Mac, or a tool without a path. */
export function folderHashOf(toolName: string, args: unknown): string | undefined {
  if (!(STRANGER_PATH_TOOLS.has(toolName) || TEAMMATE_PATH_TOOLS.has(toolName)) || onMac(args)) return undefined;
  const path = pathOf(args);
  return path === '' ? undefined : chatHashOfPath(path);
}

/** A teammate's wake (BACKEND 6.8): a stranger wake the ingress marked as a known person of an internal group. */
export function isTeammateWake(wake: WakeEvent | undefined): boolean {
  return isStrangerWake(wake) && wake?.payload['teammate'] === true;
}

/** Whether every kind of decision a call carries was delegated to the group; a call with no kind is never covered. */
export function groupGrantCovers(categories: readonly DecisionCategory[], delegated: readonly string[] | undefined): boolean {
  return categories.length > 0 && delegated !== undefined && categories.every((category) => delegated.includes(category));
}

/** Whether the run is held to the teammate rules rather than the stranger's. */
const teammateRun = (config: { chat?: ChatPolicy }, wake: WakeEvent | undefined): boolean => config.chat?.teammate === true || isTeammateWake(wake);

export function strangerScope(config: { chat?: ChatPolicy }, wake: WakeEvent | undefined, toolName: string, args: unknown): StrangerScope {
  const teammate = teammateRun(config, wake);
  if (STRANGER_ALLOWED.has(toolName) || (teammate && TEAMMATE_ALLOWED.has(toolName))) return { kind: 'free' };
  if (!STRANGER_PATH_TOOLS.has(toolName) && !(teammate && TEAMMATE_PATH_TOOLS.has(toolName))) return { kind: 'ask' };
  const path = pathOf(args);
  const hash = folderHashOf(toolName, args);
  if (hash === undefined) return { kind: 'private', path };
  const own = config.chat?.conversationId ?? wake?.conversationId;
  if (own !== undefined && chatHash(own) === hash) return { kind: 'free' };
  const other = config.chat?.other;
  if (other !== undefined && chatHash(other.id) === hash) return { kind: 'share', chat: other, path };
  return { kind: 'private', path };
}

/** What a stranger-woken run's ask is about, as the decision brief needs it. */
export type StrangerBrief =
  | { kind: 'share'; chatId: string; title: string; path: string }
  | { kind: 'private'; path: string }
  | { kind: 'ask' };

export function strangerBriefOf(scope: StrangerScope): StrangerBrief | undefined {
  if (scope.kind === 'share') return { kind: 'share', chatId: scope.chat.id, title: scope.chat.title ?? 'another chat', path: scope.path };
  if (scope.kind === 'private') return { kind: 'private', path: scope.path };
  return scope.kind === 'ask' ? { kind: 'ask' } : undefined;
}

/** The card's extra kinds of decision, platform and facts for a stranger's ask: a file from another chat is "sharing", a private file is "sensitive". */
export function withStranger(stranger: StrangerBrief, platform: DecisionPlatform, facts: DecisionFacts): { platform: DecisionPlatform; facts: DecisionFacts; categories: DecisionCategory[] } {
  if (stranger.kind === 'share') {
    return {
      platform: { kind: 'juno', name: stranger.title.slice(0, 120) },
      facts: { ...facts, targets: [{ kind: 'file', label: stranger.path.slice(0, 160) }] },
      categories: ['sharing'],
    };
  }
  if (stranger.kind === 'private') {
    return {
      platform,
      facts: {
        ...facts,
        targets: [{ kind: 'file', label: stranger.path.slice(0, 160) }],
        sensitive: [{ kind: 'private_files', label: stranger.path.slice(0, 120), source: 'verified' }],
      },
      categories: ['sensitive'],
    };
  }
  return { platform, facts, categories: [] };
}

/** The line the owner reads: who asked, where, and what for. */
export function strangerReason(config: { chat?: ChatPolicy }, name: string | undefined, phrase: string, scope: StrangerScope): string {
  const who = name ?? 'Someone';
  const where = config.chat?.title ?? 'a group chat';
  const detail = scope.kind === 'share' ? ` from "${scope.chat.title ?? 'another chat'}"` : scope.kind === 'private' && scope.path !== '' ? ` (${scope.path.slice(0, 120)})` : '';
  return `${who} asked in ${where}: ${phrase}${detail}`;
}
