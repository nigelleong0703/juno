import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { connectChannelInputSchema } from './channel.js';
import { connectorCategorySchema, createMcpServerInputSchema } from './plugin.js';

// ---------------------------------------------------------------------------
// Apps (0.65.0): every integration is an app the owner adds once (Apps page) and then turns on per agent.
//   chat   Slack, Discord, Telegram, Feishu: the Juno bot installed into a workspace, or an agent's own bot
//   work   the curated connector catalog (Gmail, Notion, ...)
//   web    reserved for the Web & video apps (not served yet)
//   custom an MCP server added by URL
// ---------------------------------------------------------------------------

export const appCategorySchema = z.enum(['chat', 'work', 'web', 'custom']);
export type AppCategory = z.infer<typeof appCategorySchema>;

/** What an agent may do through an app that changes things: Ask first (the approval card), Allow, or Off (the tools are hidden from the agent). */
export const actionsPolicySchema = z.enum(['ask', 'allow', 'off']);
export type ActionsPolicy = z.infer<typeof actionsPolicySchema>;

/** `expired`: it worked before and the sign-in is now rejected; `error`: it never worked. */
export const appInstallationStatusSchema = z.enum(['connected', 'expired', 'error']);
export type AppInstallationStatus = z.infer<typeof appInstallationStatusSchema>;

/** An agent enabled in a chat workspace: the name people @-mention it by there. */
export const appWorkspaceAgentSchema = z.object({
  agentId: idSchema,
  /** The @-mention name without the `@` (Slack user group handle, Discord role name); null while the platform cannot give the agent one. */
  handle: z.string().nullable(),
  handleStatus: z.enum(['ok', 'needs_paid_plan', 'failed']).optional(),
  /** A sentence for the owner when something needs attention (for example the free-plan note). */
  statusMessage: z.string().optional(),
});
export type AppWorkspaceAgent = z.infer<typeof appWorkspaceAgentSchema>;

/**
 * One account or workspace an app is added with: a Google account, a Slack workspace, a Discord server, an agent's own Telegram bot.
 * `id` is the stored row's id; it addresses `DELETE /v1/apps/:id/installations/:installationId`.
 */
export const appInstallationSchema = z.object({
  id: idSchema,
  appId: idSchema,
  /** The account or workspace the owner recognises: the mailbox, the workspace name, the bot username. */
  label: z.string().min(1),
  status: appInstallationStatusSchema,
  connectedAt: isoDateTimeSchema.optional(),
  /** Set for an agent's own bot (own Telegram, Slack or Discord bot): the installation belongs to this agent alone. */
  agentId: idSchema.optional(),
  /** Chat apps: true once the owner's own platform account is recognised (their private messages are trusted instructions). */
  bound: z.boolean().optional(),
  /** Chat apps: the agents enabled in this workspace. Empty for work and custom apps. */
  agents: z.array(appWorkspaceAgentSchema),
});
export type AppInstallation = z.infer<typeof appInstallationSchema>;

/** The two grants of an app. `chatRead` reads (reply, history, files, search); `actions` changes things. A grant is listed when the app offers it. */
export const appGrantsSchema = z.object({ chatRead: z.boolean(), actions: z.boolean() });
export type AppGrants = z.infer<typeof appGrantsSchema>;

/** An agent that may use the app. `actionsPolicy` is the agent's policy for the app's changing tools; absent for chat apps. */
export const appEnabledAgentSchema = z.object({ agentId: idSchema, actionsPolicy: actionsPolicySchema.optional() });
export type AppEnabledAgent = z.infer<typeof appEnabledAgentSchema>;

/**
 * How an app is added: sign in (OAuth), paste a key, nothing (it is on already), some tools public and the rest behind a sign-in (`mixed`,
 * not addable yet), install the Juno bot, or log in inside the agent's sandbox.
 */
export const appAuthKindSchema = z.enum(['oauth', 'api_key', 'none', 'mixed', 'bot_install', 'sandbox_login']);
export type AppAuthKind = z.infer<typeof appAuthKindSchema>;

/**
 * A value the owner supplies when adding an app (Claude plugins' `userConfig`): the app package declares the field, the owner's value is
 * stored sealed with their connection and goes into the server's URL or headers as `${user_config.KEY}`. A sensitive value is never shown again.
 */
export const userConfigFieldSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,59}$/),
  type: z.enum(['string', 'number', 'boolean']),
  title: z.string().min(1).max(80),
  description: z.string().max(500),
  required: z.boolean(),
  sensitive: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
});
export type UserConfigField = z.infer<typeof userConfigFieldSchema>;

/**
 * Where an app's login and tools come from (BACKEND 10.18.3). `official`: the vendor's own MCP server, the login held by us (chat and web apps too).
 * `composio`: a long-tail app through Composio, which holds the login (the page says "Login held by Composio"). `custom`: an MCP server the owner added by URL.
 */
export const appSourceSchema = z.enum(['official', 'composio', 'custom']);
export type AppSource = z.infer<typeof appSourceSchema>;

export const appSchema = z.object({
  /** The catalog id (`gmail`, `slack`); for a custom server, the id of its connection. */
  id: idSchema,
  name: z.string().min(1),
  category: appCategorySchema,
  source: appSourceSchema,
  /** Work apps: the connector catalog's own grouping (productivity, files, ...). */
  group: connectorCategorySchema.optional(),
  /** Short icon id the client resolves; the brand logo, when there is one, is `/v1/brand-icons/<app id>.png`. */
  icon: z.string(),
  /** One line for the app's tile. */
  blurb: z.string(),
  description: z.string(),
  /** Example things to ask an agent once the app is added ("try asking"); from the app catalog table. */
  tryAsking: z.array(z.string()),
  auth: appAuthKindSchema,
  /** False when this deployment cannot offer the app (no OAuth client, no key, platform plugin off): Add is disabled. */
  available: z.boolean(),
  /** Chat apps: whether the shared Juno bot can be installed into a workspace on this deployment (the own-bot modes need nothing). */
  workspaceInstall: z.boolean().optional(),
  /** The values adding the app asks the owner for (an API key, a workspace URL); send them as `{userConfig}` in the install request. Empty when adding needs none. */
  userConfig: z.array(userConfigFieldSchema),
  /** The catalog version of the app package this entry shows; an installation records the version it was added at. */
  version: z.number().int().min(1),
  /** Who makes the app and where to read about it (the package's interface block); absent when the package does not say. */
  developerName: z.string().optional(),
  brandColor: z.string().optional(),
  websiteUrl: z.string().optional(),
  privacyPolicyUrl: z.string().optional(),
  termsOfServiceUrl: z.string().optional(),
  grants: appGrantsSchema,
  installations: z.array(appInstallationSchema),
  enabledAgents: z.array(appEnabledAgentSchema),
});
export type App = z.infer<typeof appSchema>;

export const appCapabilitySchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  /** `read` belongs to Chat & read; `change` is an action. */
  kind: z.enum(['read', 'change']),
  /**
   * True while the tool is new, or its annotations changed, since the owner last reviewed the app's tools. It is a `change` and asks first,
   * whatever the agent's Actions policy says, until `POST /v1/apps/:id/tools/review` marks it reviewed.
   */
  needsReview: z.boolean().optional(),
});
export type AppCapability = z.infer<typeof appCapabilitySchema>;

/** POST /v1/apps/:id/tools/review: the owner has looked at these tools (all unreviewed ones when `tools` is absent). The answer names the tools marked. */
export const reviewAppToolsInputSchema = z.object({ tools: z.array(z.string().min(1)).max(500).optional() }).strict();
export type ReviewAppToolsInput = z.infer<typeof reviewAppToolsInputSchema>;
export const reviewAppToolsResponseSchema = z.object({ reviewed: z.array(z.string()) });
export type ReviewAppToolsResponse = z.infer<typeof reviewAppToolsResponseSchema>;

/** An install the platform is still finishing (a Telegram bot being created, a Slack workspace waiting for approval). */
export const appPendingSchema = z.object({
  id: idSchema,
  status: z.enum(['pending', 'connected', 'failed', 'expired']),
  expiresAt: isoDateTimeSchema,
  /** What the owner opens to finish it. */
  openUrl: z.string().optional(),
  error: z.string().optional(),
  agentId: idSchema.optional(),
});
export type AppPending = z.infer<typeof appPendingSchema>;

/** A how-to skill the app ships (its name and what/when line; the instructions load for an agent that has the app on). */
export const appSkillSchema = z.object({ name: z.string().min(1), description: z.string().min(1), onboarding: z.boolean() });
export type AppSkill = z.infer<typeof appSkillSchema>;

export const appDetailSchema = appSchema.extend({
  capabilities: z.array(appCapabilitySchema),
  pending: z.array(appPendingSchema),
  skills: z.array(appSkillSchema),
});
export type AppDetail = z.infer<typeof appDetailSchema>;

/**
 * POST /v1/apps/:id/install, by category:
 *   work    `{returnUrl?}` for a sign-in app, plus `{userConfig}` (the app's declared fields) for an app that asks for values such as a key
 *   chat    the old channel connect body (`{mode:'oauth'}` installs the Juno bot into a workspace, a token or `{mode:'managed'}`
 *           / `{mode:'register'}` adds an agent's own bot) plus `agentId` for an own bot
 *   custom  (`id` = `custom`) the MCP server to add, or `{connectionId}` to sign in to one again
 */
export const installAppWorkInputSchema = z.object({
  returnUrl: z.string().optional(),
  userConfig: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Sign in again to one account (or replace its values) instead of adding another. Without it an app that is already signed in gets a second account. */
  connectionId: idSchema.optional(),
});
export const installAppChatInputSchema = z.intersection(connectChannelInputSchema, z.object({ agentId: idSchema.optional() }));
/**
 * What the owner confirmed after `POST /v1/apps/custom/probe`: how the server lets people in (it is probed again and must still say the same) and
 * the read / change mark of each tool they accepted. A tool left out is a change. Required for a server added by URL; a command needs none.
 */
export const customAppConfirmSchema = z.object({
  auth: z.enum(['none', 'oauth']),
  tools: z.record(z.string().min(1).max(200), z.enum(['read', 'change'])).refine((marks) => Object.keys(marks).length <= 500, 'too many tools'),
});
export type CustomAppConfirm = z.infer<typeof customAppConfirmSchema>;
export const installAppCustomInputSchema = z.union([
  createMcpServerInputSchema.extend({ confirm: customAppConfirmSchema.optional() }),
  z.object({ connectionId: idSchema, returnUrl: z.string().optional() }),
]);

/** POST /v1/apps/custom/probe: look at an MCP server by URL before adding it. */
export const probeCustomAppInputSchema = z.object({ url: z.string().min(1).max(2000) }).strict();
export type ProbeCustomAppInput = z.infer<typeof probeCustomAppInputSchema>;
export const probedToolSchema = z.object({
  name: z.string().min(1),
  title: z.string(),
  /** Our suggestion from the server's own annotations; the owner confirms or flips it. */
  suggested: z.enum(['read', 'change']),
  /** `annotation`: the server marked it; `unmarked`: nothing did, so it is suggested as a change. */
  basis: z.enum(['annotation', 'unmarked']),
});
export const probeCustomAppResponseSchema = z.object({
  url: z.string(),
  /** `none`: it answers without a login. `oauth`: it signs people in. `api_key`: it wants a key, which a custom server cannot take yet. */
  auth: z.enum(['none', 'oauth', 'api_key']),
  /** False when it cannot be added here, with the reason in `problem`. */
  usable: z.boolean(),
  problem: z.string().optional(),
  oauth: z.object({ issuer: z.string(), scopes: z.array(z.string()), client: z.enum(['provided', 'cimd', 'dcr']) }).optional(),
  /** Only a server that answers without a login can list its tools now; an OAuth server's tools are marked after signing in (unmarked tools are changes). */
  tools: z.array(probedToolSchema).optional(),
  toolsTruncated: z.boolean().optional(),
});
export type ProbeCustomAppResponse = z.infer<typeof probeCustomAppResponseSchema>;
export type InstallAppChatInput = z.infer<typeof installAppChatInputSchema>;

export const installAppResponseSchema = z.object({
  appId: idSchema,
  /** Set when the app is added already (an API key, a bot token, a sign-in that needed no login). */
  installation: appInstallationSchema.nullable(),
  /** Set while the platform finishes it; `GET /v1/apps/:id` lists it under `pending` until it connects. */
  pending: appPendingSchema.nullable(),
  /** What the client opens: the sign-in page, the install link, the bot's link, the page to approve a new app. Null when there is nothing to open. */
  openUrl: z.string().nullable(),
});
export type InstallAppResponse = z.infer<typeof installAppResponseSchema>;

/** PUT /v1/agents/:agentId/apps/:appId: a work or custom app, for one agent. Omitted `actionsPolicy` keeps the agent's current one. */
export const setAgentAppInputSchema = z.object({ enabled: z.boolean(), actionsPolicy: actionsPolicySchema.optional() });
export type SetAgentAppInput = z.infer<typeof setAgentAppInputSchema>;
export const agentAppSchema = z.object({ agentId: idSchema, appId: idSchema, enabled: z.boolean(), actionsPolicy: actionsPolicySchema });
export type AgentApp = z.infer<typeof agentAppSchema>;

/** PUT /v1/apps/:id/installations/:installationId/agents/:agentId: a chat app, one agent in one workspace. */
export const setWorkspaceAgentInputSchema = z.object({ enabled: z.boolean() });
export type SetWorkspaceAgentInput = z.infer<typeof setWorkspaceAgentInputSchema>;
