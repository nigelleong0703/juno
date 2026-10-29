import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { uiDocSchema } from './ui.js';

// ---------------------------------------------------------------------------
// Message building blocks (shared by Items and the composer)
// ---------------------------------------------------------------------------

export const attachmentSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  kind: z.enum(['image', 'file']),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  url: z.string().optional(),
  /** Pixel size of an image, when known (absent on older rows and non-images). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** Largest file one upload accepts, in bytes (the same cap as every library file). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Most attachments one message may carry. */
export const MAX_MESSAGE_ATTACHMENTS = 5;

/** A file picked in the composer, sent once to POST /v1/uploads; the reply is the Attachment to put on the message. */
export const uploadInputSchema = z.object({
  name: z.string().min(1).max(255),
  /** The browser's File.type; empty when it does not know. */
  mimeType: z.string().max(255),
  contentBase64: z.string().min(1),
});
export type UploadInput = z.infer<typeof uploadInputSchema>;

export const mentionSchema = z.object({
  kind: z.enum(['agent', 'user', 'file']),
  id: idSchema,
  /** What the composer shows, e.g. `@Juno` or `#sandbox-comparison.md`. */
  label: z.string().min(1),
});
export type Mention = z.infer<typeof mentionSchema>;

export const citationSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  url: z.string().optional(),
  source: z.string().optional(),
  /** Links a claim back to a stored memory (SPEC 4.3 "citations to sources/memories"). */
  memoryId: idSchema.optional(),
});
export type Citation = z.infer<typeof citationSchema>;

/** One configured completion check: a sandbox command, or a path that must exist. */
export const todoCheckSchema = z.object({
  id: idSchema,
  kind: z.enum(['command', 'file']),
  /** The exact command or sandbox path. Configured by the user; never invented by the model. */
  spec: z.string().min(1),
  /** For `command` checks: text the output must contain for the check to pass. */
  expect: z.string().optional(),
});
export type TodoCheck = z.infer<typeof todoCheckSchema>;

/** What the completion hook observed for one task; `passed: false` keeps the task unfinished. */
export const todoEvidenceSchema = z.object({
  at: isoDateTimeSchema,
  passed: z.boolean(),
  summary: z.string().min(1),
});
export type TodoEvidence = z.infer<typeof todoEvidenceSchema>;

export const todoSchema = z.object({
  id: idSchema,
  text: z.string().min(1),
  /** `blocked` requires a non-empty `note` naming the actual missing input or dependency. */
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
  note: z.string().optional(),
  /**
   * Completion evidence the user configures through the API. The model never sets these: a check the
   * model invented could always be satisfied by the model's own claim.
   */
  checks: z.array(todoCheckSchema).optional(),
  /** The last outcome the completion hook recorded for this task. */
  evidence: todoEvidenceSchema.optional(),
});
export type Todo = z.infer<typeof todoSchema>;

export const systemActionSchema = z.object({
  label: z.string().min(1),
  /** Command id the shell dispatches, e.g. `computer.resume`. */
  command: z.string().min(1),
});
export type SystemAction = z.infer<typeof systemActionSchema>;

// ---------------------------------------------------------------------------
// Item — the discriminated union (ARCHITECTURE §2)
// ---------------------------------------------------------------------------

const itemBase = {
  id: idSchema,
  conversationId: idSchema,
  at: isoDateTimeSchema,
};

/**
 * Where on a messaging platform a message came from, or where a reply goes (0.41.0). A user's private message to an
 * agent on Slack / Telegram / Discord / Feishu lands in the same direct conversation as the in-app chat; this says
 * which platform chat it was, so the reply can follow it. `channelId` is the connected channel's id (see ConnectedChannel).
 */
export const channelOriginSchema = z.object({
  kind: z.string().min(1).max(32),
  channelId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200).optional(),
  chatType: z.enum(['private', 'group']).optional(),
  /** The platform message this reply answers (0.43.0): in a group chat the reply is posted as a reply to it. Absent in private chats. */
  messageId: z.string().min(1).max(200).optional(),
  /** The platform user who sent that message (group chats): Discord names them in the reply line of a server reply. */
  userId: z.string().min(1).max(200).optional(),
});
export type ChannelOrigin = z.infer<typeof channelOriginSchema>;

export const userMessageItemSchema = z.object({
  ...itemBase,
  type: z.literal('user_message'),
  /**
   * Who spoke (0.46.0): the owner's account id when the owner wrote it (typed in the app, or said on a platform as the bound owner),
   * otherwise a stable synthetic id for that outside speaker, `ext-<platform>-<16 hex of sha256(channelSender.externalId)>`. It is
   * never the owner's id for someone else's words. The row is still scoped to the owner account by the store, not by this field.
   */
  authorId: idSchema,
  text: z.string(),
  attachments: z.array(attachmentSchema),
  mentions: z.array(mentionSchema),
  /** One emoji the agent reacted with to this message (the `react` tool); a later reaction replaces it. */
  reaction: z.string().min(1).max(16).optional(),
  /**
   * Who spoke, for a message that arrived on a messaging platform (0.39.0). Authoritative for display (name, side of the bubble):
   * `authorId` follows it (the owner's id for `owner`, a synthetic `ext-…` id for a `stranger`, since 0.46.0). A `stranger` is
   * anyone but the bound owner.
   */
  channelSender: z.object({
    kind: z.string().min(1).max(32),
    externalId: z.string().min(1).max(128),
    name: z.string().max(200),
    role: z.enum(['owner', 'stranger']),
  }).optional(),
  /** The platform chat this message arrived from (0.41.0); absent for a message typed in the app. */
  source: channelOriginSchema.optional(),
});

export const agentMessageItemSchema = z.object({
  ...itemBase,
  type: z.literal('agent_message'),
  agentId: idSchema,
  /** PH12: the run that produced this reply, so a reply can be linked to its task. Optional. */
  runId: idSchema.optional(),
  markdown: z.string(),
  citations: z.array(citationSchema),
  /** Structured blocks shown under `markdown` (a short lead-in, or `uiDocToText(ui)` when the agent gave no text). */
  ui: uiDocSchema.optional(),
  /**
   * The platform chat this reply is delivered to (0.41.0): the origin of the message that woke the run. Absent for a reply to a
   * message typed in the app (it stays in the app) and for anything no user message started.
   */
  replyTo: channelOriginSchema.optional(),
});

export const runItemSchema = z.object({
  ...itemBase,
  type: z.literal('run'),
  runId: idSchema,
});

export const planItemSchema = z.object({
  ...itemBase,
  type: z.literal('plan'),
  runId: idSchema,
  /** Authoritative owning agent; legacy plans omit it and are attributed through their run. */
  agentId: idSchema.optional(),
  todos: z.array(todoSchema),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const requestItemSchema = z.object({
  ...itemBase,
  type: z.literal('request'),
  requestId: idSchema,
});

export const artifactItemSchema = z.object({
  ...itemBase,
  type: z.literal('artifact'),
  artifactId: idSchema,
  /** The version this message published; the card shows the newest (`Artifact.version`) and "updated vN" when they differ. Absent on send_file items. */
  version: z.number().int().min(1).optional(),
});

export const routineItemSchema = z.object({
  ...itemBase,
  type: z.literal('routine'),
  routineId: idSchema,
  change: z.enum(['created', 'updated']),
});

export const handoffItemSchema = z.object({
  ...itemBase,
  type: z.literal('handoff'),
  direction: z.enum(['to_user', 'to_agent']),
  /** The agent that handed off (the sender) and, for `to_agent`, the agent it handed to. */
  agentId: idSchema.optional(),
  toAgentId: idSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
});

/** The agent's once-per-agent role suggestion, shown as a card in the chat (BACKEND §10.11). Its state is derived from the agent. */
export const roleSuggestionItemSchema = z.object({
  ...itemBase,
  type: z.literal('role_suggestion'),
  agentId: idSchema,
  title: z.string(),
  description: z.string(),
  /** Equals the agent's `roleSuggestion.createdAt`; a card is pending while they match. */
  suggestionAt: isoDateTimeSchema,
});

/** A card in the chat pointing at a feed post the agent published during a run the user started from this conversation; tap opens the post in the Feed. */
export const feedRefItemSchema = z.object({
  ...itemBase,
  type: z.literal('feed_ref'),
  agentId: idSchema,
  runId: idSchema.optional(),
  feedPostId: idSchema,
  title: z.string(),
  summary: z.string().optional(),
  imageUrl: z.string().min(1).optional(),
});

export const systemItemSchema = z.object({
  ...itemBase,
  type: z.literal('system'),
  level: z.enum(['info', 'warning', 'error']),
  text: z.string(),
  action: systemActionSchema.optional(),
});

export const itemSchema = z.discriminatedUnion('type', [
  userMessageItemSchema,
  agentMessageItemSchema,
  runItemSchema,
  planItemSchema,
  requestItemSchema,
  artifactItemSchema,
  routineItemSchema,
  handoffItemSchema,
  systemItemSchema,
  roleSuggestionItemSchema,
  feedRefItemSchema,
]);
export type Item = z.infer<typeof itemSchema>;
export type ItemType = Item['type'];

/** `peer` = a thread between two agents (BACKEND §6.1); hidden from the chat list. */
export const conversationKindSchema = z.enum(['direct', 'room', 'task', 'peer']);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

export const conversationSchema = z.object({
  id: idSchema,
  kind: conversationKindSchema,
  /** Null for a direct conversation; a name for rooms and task threads. */
  title: z.string().optional(),
  /** Agent participants. */
  agentIds: z.array(idSchema),
  /** Human participants (member ids). */
  memberIds: z.array(idSchema),
  /** For `kind: 'task'`, the run this thread belongs to. */
  taskRunId: idSchema.optional(),
  /** Rooms (BACKEND §6.2): who wakes on an un-mentioned message. Default `mention`. */
  roomMode: z.enum(['mention', 'open_floor']).optional(),
  /** Rooms: the agent woken when nobody is mentioned (default: the first agent). */
  hostAgentId: idSchema.optional(),
  /**
   * Derived on every read by `withLiveActivity()` (never the stored value): the unread items that
   * did not come from the user, capped at 99 (render 99+). See BACKEND "会话未读数与最近活动时间".
   */
  unreadCount: z.number().int().min(0),
  /** When the user last marked the conversation read; the unread count is everything newer. */
  lastReadAt: isoDateTimeSchema.optional(),
  /** Derived on every read: set when the chat lives on a messaging platform (Telegram, Slack, ...), so clients can badge it. */
  channel: z.object({ kind: z.string(), channelId: z.string() }).optional(),
  /** Pinned to the top of the chat list. Stored on the conversation (the owner is its only user today). */
  pinned: z.boolean().optional(),
  /** Muted: clients skip OS notifications and toasts for this conversation. Unread counts keep counting. */
  muted: z.boolean().optional(),
  /** Derived on every read: the newest message-like item (see `unreadCount`), else `createdAt`. */
  lastItemAt: isoDateTimeSchema,
  /**
   * Derived on every read: one plain-text line (markdown stripped, about 140 chars) of the newest
   * `user_message` / `agent_message`; an attachments-only message reads "📎 <name>". Absent until the
   * chat has a message. See BACKEND "会话未读数与最近活动时间".
   */
  lastMessagePreview: z.string().optional(),
  /** Derived with `lastMessagePreview`: who said it and when (`agentId` set when an agent did). */
  lastMessage: z
    .object({
      text: z.string(),
      authorKind: z.enum(['user', 'agent']),
      agentId: idSchema.optional(),
      at: isoDateTimeSchema,
    })
    .optional(),
  /** 0.70: the document this chat is about (BACKEND 5.11a); the agent's context names it and its draft state. Set by `POST /v1/documents/:id/conversations`. */
  documentId: idSchema.optional(),
  /** Pending requests waiting on the user in this conversation (v0.3 "needs you"). */
  needsYou: z.number().int().min(0).optional(),
  createdAt: isoDateTimeSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;

/** Patch accepted by `conversations.update()`: the per-chat sidebar flags. */
export const updateConversationInputSchema = z
  .object({
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
  })
  .strict();
export type UpdateConversationInput = z.infer<typeof updateConversationInputSchema>;

// ---------------------------------------------------------------------------
// Composer payload (ARCHITECTURE §6 "Composer")
// ---------------------------------------------------------------------------

export const composerCommandSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});

export const composerOptionsSchema = z.object({
  model: z.string().optional(),
  background: z.boolean().optional(),
});

export const composerPayloadSchema = z.object({
  text: z.string(),
  attachments: z.array(attachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  mentions: z.array(mentionSchema).optional(),
  command: composerCommandSchema.optional(),
  options: composerOptionsSchema.optional(),
});
export type ComposerPayload = z.infer<typeof composerPayloadSchema>;
