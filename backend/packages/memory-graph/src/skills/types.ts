/**
 * Skill definitions and their immutable versions (migration 0049). A definition keeps its id; a content change is a new version row;
 * `activeVersionId` is the pointer the runtime loads. Owner-scoped: every query in repo.ts filters on owner_id.
 */

export type SkillScope = 'agent' | 'owner';
export type SkillStatus = 'candidate' | 'active' | 'review' | 'retired';
export type SkillOrigin = 'manual' | 'taught' | 'learned' | 'installed';

/**
 * What a skill needs. A tool dep names a tool and carries the schema hash it was last seen with (null until first seen); a connector dep
 * names a catalog connector the owner must have connected for the skill to load.
 */
export type SkillDep =
  | { type: 'tool'; name: string; schemaHash: string | null }
  | { type: 'connector'; catalogId: string };

/** What the owner (or an agent, later) writes. Hashes are never written by callers: they are pinned by the recheck. */
export type SkillDepInput = { type: 'tool'; name: string } | { type: 'connector'; catalogId: string };

export interface SkillDef {
  id: string;
  ownerId: string;
  scope: SkillScope;
  agentId: string | null;
  slug: string;
  activeVersionId: string | null;
  createdAt: string;
}

export interface SkillVersion {
  id: string;
  ownerId: string;
  skillId: string;
  version: number;
  status: SkillStatus;
  name: string;
  description: string;
  instructions: string;
  deps: SkillDep[];
  origin: SkillOrigin;
  used: number;
  helpful: number;
  harmful: number;
  lastUsedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** A definition with its active version (null when the pointer is empty). */
export interface SkillView {
  def: SkillDef;
  active: SkillVersion | null;
}

/** One skill an agent may load now: active, scope-allowed, and every connector dep connected. */
export interface LoadableSkill {
  id: string;
  versionId: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
}

export interface NewSkillInput {
  name: string;
  description: string;
  instructions: string;
  deps: SkillDepInput[];
  /** Set for an agent-scoped skill; absent means owner scope. */
  agentId?: string;
}

/** Tool name to its current schema hash, or undefined when the tool is not present in this process or run. */
export type ToolHashes = (name: string) => string | undefined;

export interface RecheckReport {
  /** Tool deps whose hash was pinned for the first time. */
  pinned: number;
  /** Versions moved to `review` because a tool's schema changed: skill id and version number. */
  reviewed: Array<{ skillId: string; version: number; tool: string }>;
}

/** A refusal with a stable code the routes map to a 4xx; `message` is for the owner. */
export class SkillError extends Error {
  constructor(public readonly code: 'SKILL_NOT_FOUND' | 'SKILL_VERSION_NOT_FOUND' | 'SKILL_NO_PREVIOUS_VERSION' | 'SKILL_INVALID', message: string) {
    super(message);
  }
}
