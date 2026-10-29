import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const pluginCategorySchema = z.enum([
  'Productivity',
  'Engineering',
  'Sales',
  'Support',
  'Finance',
  'Design',
  'Data',
]);
export type PluginCategory = z.infer<typeof pluginCategorySchema>;

/** Per-tool permission (SPEC 4.10): Always allow / Ask / Never. */
export const toolPermissionSchema = z.enum(['always', 'ask', 'never']);
export type ToolPermission = z.infer<typeof toolPermissionSchema>;

export const pluginToolSchema = z.object({
  id: idSchema,
  pluginId: idSchema,
  name: z.string().min(1),
  description: z.string(),
  permission: toolPermissionSchema,
});
export type PluginTool = z.infer<typeof pluginToolSchema>;

export const pluginAccountSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  status: z.enum(['connected', 'error', 'expired']),
  connectedAt: isoDateTimeSchema,
});

export const pluginSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  publisher: z.string().min(1),
  category: pluginCategorySchema,
  description: z.string(),
  /** Short icon key resolved by the UI (emoji-free identifier). */
  icon: z.string(),
  installed: z.boolean(),
  featured: z.boolean(),
  tools: z.array(pluginToolSchema),
  accounts: z.array(pluginAccountSchema),
  /** Agents that may use this plugin. */
  usedByAgentIds: z.array(idSchema),
});
export type Plugin = z.infer<typeof pluginSchema>;

export const connectorCategorySchema = z.enum(['productivity', 'files', 'projects', 'finance', 'automation', 'media', 'travel', 'health']);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

export const connectionKindSchema = z.enum(['oauth', 'apikey', 'mcp']);
export type ConnectionKind = z.infer<typeof connectionKindSchema>;

export const connectionSchema = z.object({
  id: idSchema,
  pluginId: idSchema.optional(),
  name: z.string().min(1),
  kind: connectionKindSchema,
  status: z.enum(['connected', 'disconnected', 'error']),
  account: z.string().optional(),
  /** For MCP servers: command or URL. */
  endpoint: z.string().optional(),
  /** MCP only: false once the user disconnects, which is distinct from never-initialized. */
  enabled: z.boolean().optional(),
  connectedAt: isoDateTimeSchema.optional(),
  lastUsedAt: isoDateTimeSchema.optional(),
  /** Set when the connection was created from the connector catalog. */
  catalogId: z.string().optional(),
});
export type Connection = z.infer<typeof connectionSchema>;

/** Write-only secret metadata — value is never carried by the client. */
export const secretSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  scope: z.enum(['personal', 'team']),
  source: z.enum(['manual', 'oauth', 'mcp', 'password_manager']),
  updatedAt: isoDateTimeSchema,
});
export type SecretMetadata = z.infer<typeof secretSchema>;

export const createMcpServerInputSchema = z.object({
  name: z.string().min(1),
  /** Transport kind; inferred from url/command when omitted. */
  transport: z.enum(['http', 'stdio']).optional(),
  /** Either a local command or a URL. */
  command: z.string().optional(),
  /** Arguments for a stdio command. */
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type CreateMcpServerInput = z.infer<typeof createMcpServerInputSchema>;
