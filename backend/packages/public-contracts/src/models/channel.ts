import { z } from 'zod';

// ---------------------------------------------------------------------------
// Chat platforms as apps (0.65.0): the bodies of `POST /v1/apps/:id/install` for Slack, Discord, Telegram and Feishu.
// Nobody pastes a token or a secret: Slack and Discord install the one Juno app, Telegram creates a managed bot, Feishu / Lark
// creates the app by scanning, and the owner only confirms on the platform.
// What came back from the old per-agent connect (connected channels, pending channels) is an `AppInstallation` / `AppPending` now (apps.ts).
// Not to be confused with `channelSchema` in agent.ts (the per-agent channel summary).
// ---------------------------------------------------------------------------

/** Telegram: Juno creates the agent's bot with Telegram's Managed Bots; the person confirms the name in Telegram. */
export const connectTelegramManagedInputSchema = z.object({
  mode: z.literal('managed'),
  suggestedUsername: z.string().min(1).optional(),
});
/** Feishu / Lark: Juno creates the app with the official scan-to-create flow; the person confirms in Feishu / Lark. */
export const connectFeishuRegisterInputSchema = z.object({
  mode: z.literal('register'),
  domain: z.enum(['feishu', 'lark']).optional(),
});

/** Slack / Discord shared app: install the one Juno bot into a workspace / server; agents are enabled there afterwards. */
export const connectOAuthInputSchema = z.object({ mode: z.literal('oauth') });

export const connectChannelInputSchema = z.union([
  connectOAuthInputSchema,
  connectTelegramManagedInputSchema,
  connectFeishuRegisterInputSchema,
]);
export type ConnectChannelInput = z.infer<typeof connectChannelInputSchema>;

// ---------------------------------------------------------------------------
// Group settings (BACKEND 6.8): what the owner decided for one group chat of an agent on a platform. Only the owner reads or
// changes them (`GET` / `PUT /v1/conversations/:id/group`, any conversation of the group).
// ---------------------------------------------------------------------------

/** The kinds of decision a teammate's ask may use without asking the owner first (the delegated-authority categories). */
export const groupDelegableCategorySchema = z.enum(['spending', 'speaking', 'public', 'committing', 'sharing']);
export type GroupDelegableCategory = z.infer<typeof groupDelegableCategorySchema>;

export const groupSettingsSchema = z.object({
  /** The platform's kind (`slack`, `discord`, `telegram`, `feishu`). */
  platform: z.string().min(1),
  title: z.string().optional(),
  /**
   * Whether the platform delivers the channel's messages that are not addressed to the agent (its capability row `hears`, with the
   * permissions the app was granted). The agent reads those to keep context ("<agent> reads this channel to keep context"); when false
   * it only sees what is addressed to it.
   */
  observes: z.boolean(),
  /** "May speak up without being @mentioned": the chat digest may wake the agent in a thread for a follow-up or an answer only it has. Off by default. */
  speak: z.boolean(),
  /** The categories a teammate may use without the owner being asked first (from this group). Empty by default. */
  delegated: z.array(groupDelegableCategorySchema),
  /** The earlier messages read when the agent joined this channel. Absent: not started. `unavailable`: the platform cannot read earlier messages. */
  backfill: z.object({
    status: z.enum(['running', 'done', 'unavailable', 'failed']),
    /** How many earlier messages were read. */
    count: z.number().int().min(0).optional(),
    /** When it started (`running`) or finished. */
    at: z.string(),
  }).optional(),
});
export type GroupSettings = z.infer<typeof groupSettingsSchema>;

export const updateGroupSettingsInputSchema = z.object({
  speak: z.boolean().optional(),
  delegated: z.array(groupDelegableCategorySchema).max(5).optional(),
});
export type UpdateGroupSettingsInput = z.infer<typeof updateGroupSettingsInputSchema>;
