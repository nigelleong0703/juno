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

/** Tools that take a `path`: allowed inside this chat's folder, asked for anywhere else. */
export const STRANGER_PATH_TOOLS: ReadonlySet<string> = new Set(['files.read', 'files.write', 'artifact_publish']);

/** What the policy knows about the chat a stranger-woken run is in (filled by `readToolPolicyConfig`, only for such a run). */
export interface ChatPolicy {
  conversationId: string;
  title?: string;
  /** Someone other than the owner woke this run: their name as the platform gave it. */
  stranger?: { name?: string };
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
  if (!STRANGER_PATH_TOOLS.has(toolName) || onMac(args)) return undefined;
  const path = pathOf(args);
  return path === '' ? undefined : chatHashOfPath(path);
}

export function strangerScope(config: { chat?: ChatPolicy }, wake: WakeEvent | undefined, toolName: string, args: unknown): StrangerScope {
  if (STRANGER_ALLOWED.has(toolName)) return { kind: 'free' };
  if (!STRANGER_PATH_TOOLS.has(toolName)) return { kind: 'ask' };
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
