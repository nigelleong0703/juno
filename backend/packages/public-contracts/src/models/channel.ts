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
