import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/**
 * A skill is versioned (memory-graph design §7): the definition keeps its id, every content change is a new version, and `active` is the
 * version the agent loads. Rolling back moves the pointer; a version's text never changes.
 */

/** What a skill needs: a tool (its schema is checked; `schemaHash` is null until first seen) or a connector (must be connected to load). */
export const skillDepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), name: z.string().min(1).max(200), schemaHash: z.string().nullable() }),
  z.object({ type: z.literal('connector'), catalogId: z.string().min(1).max(120) }),
]);
export type SkillDep = z.infer<typeof skillDepSchema>;

/** A dep as written: the server pins hashes itself, so a written tool dep carries only its name. */
export const skillDepInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), name: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('connector'), catalogId: z.string().min(1).max(120) }).strict(),
]);
export type SkillDepInput = z.infer<typeof skillDepInputSchema>;

export const skillVersionStatusSchema = z.enum(['candidate', 'active', 'review', 'retired']);
export const skillOriginSchema = z.enum(['manual', 'taught', 'learned', 'installed']);

export const skillVersionSchema = z.object({
  id: idSchema,
  skillId: idSchema,
  version: z.number().int().min(1),
  /** `review`: a tool this skill uses changed its schema; the skill does not load until the owner activates it again or rolls back. */
  status: skillVersionStatusSchema,
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string(),
  deps: z.array(skillDepSchema),
  origin: skillOriginSchema,
  used: z.number().int().min(0),
  helpful: z.number().int().min(0),
  harmful: z.number().int().min(0),
  lastUsedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const skillSchema = z.object({
  id: idSchema,
  /** `agent`: only the agent it belongs to may load it; `owner`: any agent the owner selects it for. */
  scope: z.enum(['agent', 'owner']),
  agentId: idSchema.nullable(),
  /** The version the agent loads; null only when the pointer is empty. */
  active: skillVersionSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Skill = z.infer<typeof skillSchema>;

/** Create a skill (version 1, active). An agent-scoped skill names its agent. */
export const createSkillInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(240).default(''),
  instructions: z.string().min(1).max(20_000),
  deps: z.array(skillDepInputSchema).max(32).default([]),
  agentId: idSchema.optional(),
});
export type CreateSkillInput = z.input<typeof createSkillInputSchema>;

/** Edit a skill: the new content becomes a new active version (the previous active one is retired). Scope does not change. */
export const updateSkillInputSchema = createSkillInputSchema.omit({ agentId: true });
export type UpdateSkillInput = z.input<typeof updateSkillInputSchema>;
