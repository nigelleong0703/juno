import { MAX_UPLOAD_BYTES } from './conversation.js';

// ---------------------------------------------------------------------------
// What each chat surface can do: the capability interface of the chat platforms. Default: everything is possible, and a platform
// declares only what it cannot do (`declareCapabilities`). The declaration belongs to the platform's adapter (@agent-desktop/channels,
// `<platform>/abilities.ts`); agentd registers it here under the platform kind when the platform's plugin loads (`registerChatSurface`)
// and takes it back when the plugin is disabled. Three readers: the agent's "Where you are" section (juno-agent execution/brain/
// where-you-are.ts renders it), the tools that act on a chat (react and channel_history refuse where it says no) and agentd's platform
// adapters (a method it has not implemented answers `unsupported`, which the agent reads as "not available here", never as an error).
// The registry lives here because this is the one package both juno-agent and agentd import (`channels` and `contracts` depend on
// juno-agent, so juno-agent cannot import them). Change a declaration only when the code really gained or lost the ability.
// ---------------------------------------------------------------------------

export type WorkObject = 'doc' | 'calendar' | 'task' | 'canvas' | 'sheet';

export interface ChatCapabilities {
  /** What reaches the agent: only messages addressed to it (mentions, replies, DMs), or every message. */
  hears: 'addressed' | 'all';
  history: {
    /** The messages just before a mention arrive with the wake. */
    window: boolean;
    /** `channel_history`: the agent reads earlier messages of this chat when it asks. */
    onDemand: boolean;
    /** Messages from before the bot joined the chat are readable. */
    beforeJoin: boolean;
  };
  /** Files people post (read) and files the agent posts (send); limits in MB: the app's upload cap, since every file moves through the library. */
  files: { read: boolean; send: boolean; maxReadMb: number; maxSendMb: number };
  /** `any`: every emoji; `limited`: only `allowed`; `none`: no reactions. */
  reactions: { mode: 'any' | 'limited' | 'none'; allowed?: readonly string[] };
  /** Interactive cards, choice buttons (a question card's `choices` block), input fields (a `fields` block). */
  ui: { cards: boolean; choices: boolean; fields: boolean };
  /** Replies can go in a thread. */
  threads: boolean;
  /** Things the agent can make as itself on the platform (docs, events, tasks, canvases). */
  workObjects: readonly WorkObject[];
  /** How the agent behaves in groups with outside parties (Slack Connect, Feishu external groups). */
  externalGroups: 'quiet' | 'normal';
}

/** An emoji without its variation selector, so "❤" and "❤️" are the same key. */
export function plainEmoji(emoji: string): string {
  return emoji.replaceAll('️', '');
}

const MB = 1024 * 1024;
/** The app's upload cap in MB: the most a platform file may be, either way (inbound files are stored in the library like uploads). */
const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / MB;

/** What a platform declares it cannot do; every field left out keeps the default (everything possible). */
export interface Cannot {
  hears?: ChatCapabilities['hears'];
  history?: Partial<ChatCapabilities['history']>;
  files?: Partial<ChatCapabilities['files']>;
  reactions?: ChatCapabilities['reactions'];
  ui?: Partial<ChatCapabilities['ui']>;
  externalGroups?: ChatCapabilities['externalGroups'];
}

export function declareCapabilities(cannot: Cannot): ChatCapabilities {
  return {
    hears: cannot.hears ?? 'addressed',
    history: { window: true, onDemand: true, beforeJoin: true, ...cannot.history },
    files: { read: true, send: true, maxReadMb: MAX_UPLOAD_MB, maxSendMb: MAX_UPLOAD_MB, ...cannot.files },
    reactions: cannot.reactions ?? { mode: 'any' },
    ui: { cards: true, choices: true, fields: true, ...cannot.ui },
    threads: true,
    workObjects: [],
    externalGroups: cannot.externalGroups ?? 'quiet',
  };
}

export const NO_HISTORY = { window: false, onDemand: false, beforeJoin: false };

/** What a platform's chats can do, given the optional platform permissions its connected app was granted. */
export type ChatSurfaceDeclaration = (grants: readonly string[]) => ChatCapabilities;

const APP_CAPABILITIES = declareCapabilities({ hears: 'all', history: NO_HISTORY, externalGroups: 'normal' });

const PLAINEST: ChatCapabilities = declareCapabilities({
  history: NO_HISTORY, files: { read: false, send: false, maxReadMb: 0, maxSendMb: 0 }, reactions: { mode: 'none' }, ui: { cards: false, choices: false, fields: false },
});

const surfaces = new Map<string, ChatSurfaceDeclaration>();

/** Declares what a platform's chats can do, under its kind; the returned function takes the declaration back. */
export function registerChatSurface(kind: string, declaration: ChatSurfaceDeclaration): () => void {
  surfaces.set(kind, declaration);
  return () => {
    if (surfaces.get(kind) === declaration) surfaces.delete(kind);
  };
}

/**
 * What a surface can do: the Juno app, a registered platform, or (a platform nobody registered: disabled, unknown) the plainest chat,
 * text only. `grants` are the optional platform permissions the connected app was given (a Feishu app without admin approval has none).
 */
export function chatCapabilities(surface: string, grants: readonly string[] = []): ChatCapabilities {
  if (surface === 'app') return APP_CAPABILITIES;
  return surfaces.get(surface)?.(grants) ?? PLAINEST;
}

/** Whether a reaction with this emoji can be put on a message in a chat with these capabilities. */
export function reactionAllowed(reactions: ChatCapabilities['reactions'], emoji: string): boolean {
  if (reactions.mode === 'none') return false;
  return reactions.mode === 'any' || (reactions.allowed ?? []).some((allowed) => plainEmoji(allowed) === plainEmoji(emoji));
}
