import { z } from 'zod';
import { agentStatusSchema, idSchema, isoDateTimeSchema } from './common.js';
import { avatarSpecSchema } from './avatar.js';
import { agentEngineSchema } from './engine.js';

/** Provider + model + knobs for one agent role (SPEC 4.12 "Model"). */
export const modelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Optional reasoning/effort hint, e.g. `low` | `medium` | `high`. */
  effort: z.enum(['low', 'medium', 'high']).optional(),
  /** Seconds or tokens budget for this role, rendered as "time budget". */
  budgetSeconds: z.number().int().min(0).optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const agentModelsSchema = z.object({
  planner: modelConfigSchema,
  computer: modelConfigSchema,
  fast: modelConfigSchema,
});
export type AgentModels = z.infer<typeof agentModelsSchema>;

export const channelKindSchema = z.enum(['chat', 'slack', 'email', 'sms', 'phone', 'telegram', 'discord', 'feishu']);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const channelSchema = z.object({
  kind: channelKindSchema,
  status: z.enum(['connected', 'available', 'disconnected', 'error']),
  /** e.g. workspace name, address, phone number. */
  detail: z.string().optional(),
  /** For Slack/email: who is allowed to direct this agent. */
  audience: z.string().optional(),
});
export type Channel = z.infer<typeof channelSchema>;

/** Per-agent permission tiers; an absent key means the default (send ask, purchase ask, browsing normal, reachOut normal, readHistory on). */
export const permissionTiersSchema = z.object({
  send: z.enum(['always', 'ask', 'never']).optional(),
  purchase: z.enum(['ask', 'never']).optional(),
  browsing: z.enum(['strict', 'normal', 'loose']).optional(),
  reachOut: z.enum(['off', 'less', 'normal', 'more']).optional(),
  /** `off`: the agent reads no earlier messages of a platform chat (not the ones before a mention, not `channel_history`, not for the group note). */
  readHistory: z.enum(['on', 'off']).optional(),
});
export type PermissionTiers = z.infer<typeof permissionTiersSchema>;

export const agentSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  /** Without the leading `@`. */
  handle: z.string().min(1),
  avatar: avatarSpecSchema,
  /** Short role line, e.g. "Research & inbox". */
  title: z.string().min(1),
  /** Longer description of the agent's role. */
  description: z.string().optional(),
  /** Role suggested from the first messages (BACKEND §10.11); cleared on accept or dismiss. */
  roleSuggestion: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    createdAt: isoDateTimeSchema,
  }).optional(),
  /** Set when the user dismisses a suggestion: no new suggestion while the title stays unset. */
  roleSuggestionDismissedAt: isoDateTimeSchema.optional(),
  /** How many sub-tasks this agent may have running at once; unset means the platform default. */
  maxSubTasks: z.number().int().min(1).optional(),
  permissionTiers: permissionTiersSchema.optional(),
  /** Derived on every read from runs/requests/pause (never the stored value), see agentStatus(). */
  status: agentStatusSchema,
  /** One line on what the agent is doing right now; present only while `status` is `working`. */
  doing: z.string().optional(),
  /** When the user paused this agent; absent when it is not paused. */
  pausedAt: isoDateTimeSchema.optional(),
  /** Sidebar section this agent lives in, e.g. "Personal" | "Work". */
  section: z.string().min(1),
  pinned: z.boolean(),
  /** One-line latest activity shown in the sidebar row. */
  lastActivity: z.string(),
  /** Not populated by the backend (always 0) and unused by the UI: read `Conversation.unreadCount` instead. */
  unreadCount: z.number().int().min(0),
  /** When the agent was last active (v0.3 sidebar ordering). */
  lastActivityAt: isoDateTimeSchema.optional(),
  /** Pending requests waiting on the user for this agent (v0.3 "needs you"). */
  needsYou: z.number().int().min(0).optional(),
  /**
   * @deprecated Per-agent model selection is removed. Optional read-only
   * compatibility for previously stored agent data; never sent in patches.
   */
  model: agentModelsSchema.optional(),
  channels: z.array(channelSchema),
  /**
   * The agent may also use the owner's own Mac (My Mac) next to its sandbox. The sandbox is always its computer; per call the
   * file and shell tools choose `on: "sandbox" | "mac"` (default sandbox). Default on a new agent: true in the desktop app,
   * false on a server (turning it on there needs a paired Mac).
   */
  macAccess: z.boolean(),
  skillIds: z.array(idSchema),
  pluginIds: z.array(idSchema),
  /**
   * @deprecated Per-agent engine binding is removed. Optional read-only
   * compatibility for previously stored agent data; never sent in patches.
   */
  engine: agentEngineSchema.optional(),
  /** Team sharing (SPEC 4.12 "Access"). */
  sharing: z.object({
    publishedToTeam: z.boolean(),
    templateSlug: z.string().optional(),
  }),
  /** Member id of the user who created this agent (v0.3: agents are user-created contacts). */
  createdBy: idSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Agent = z.infer<typeof agentSchema>;

/** Hard cap on how many skills one agent may select; keeps the resource context bounded. */
export const MAX_AGENT_SKILL_SELECTIONS = 20;

/** Input accepted by `agents.create()` (SPEC 4.13 New agent dialog). */
export const createAgentInputSchema = z.object({
  /** Optional since 0.54.0: when absent the server picks the owner's first unused name from a short list (Nova, Atlas, …). A name that is given and already used by another of the owner's agents is refused with 409 `AGENT_NAME_TAKEN`. */
  name: z.string().min(1).optional(),
  handle: z.string().min(1).optional(),
  avatar: avatarSpecSchema.optional(),
  title: z.string().optional(),
  /** Initial contents of the agent's home files (IDENTITY / SOUL / AGENTS / TOOLS.md, BACKEND §5.1); later edits go through `/v1/agents/:id/home`. */
  personality: z.string().optional(),
  principles: z.string().optional(),
  instructions: z.string().optional(),
  toolNotes: z.string().optional(),
  proactivePreferences: z.string().optional(),
  maxSubTasks: z.number().int().min(1).optional(),
  /** On PATCH each key given replaces that key; keys left out keep their current value. */
  permissionTiers: permissionTiersSchema.optional(),
  section: z.string().optional(),
  templateSlug: z.string().optional(),
  /** Skills the agent may use;. */
  skillIds: z.array(idSchema).max(MAX_AGENT_SKILL_SELECTIONS).optional(),
  pluginIds: z.array(idSchema).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

/** Patch accepted by `agents.update()` (Agent settings screen). */
export const updateAgentInputSchema = createAgentInputSchema
  .omit({ personality: true, principles: true, instructions: true, toolNotes: true, proactivePreferences: true })
  .partial()
  .extend({
    pinned: z.boolean().optional(),
    /** @deprecated Obsolete per-agent model PATCH key; rejected. */
    model: z.never().optional(),
    /** @deprecated Obsolete per-agent engine PATCH key; rejected. */
    engine: z.never().optional(),
    channels: z.array(channelSchema).optional(),
    sharing: agentSchema.shape.sharing.partial().optional(),
    macAccess: z.boolean().optional(),
  });
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;
