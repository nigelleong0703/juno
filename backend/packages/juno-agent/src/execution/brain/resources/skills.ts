// Authorized skill resources for one run. A skill is read from the versioned skill store (memory-graph/skills), only when the current agent
// selected it, and the store loads only what may load now: the owner's own active version, scoped to this agent, with every connector it
// needs connected. There is no host AGENTS.md/SKILL.md discovery and no filesystem access, and an agent with no configured selection renders
// no resource section at all.
import type { Store } from '../../../contracts/index.js';
import { MAX_AGENT_SKILL_SELECTIONS } from '@agent-desktop/public-contracts';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import type { PlatformSkill } from '../../../ports/computer/index.js';
import { docOwner } from '../../execution-owner.js';
import { harnessText } from '../../../modules/harness/loader.js';
import { listAll } from '../../../modules/memory/util.js';
import { quoteId } from '../social-format.js';
import { readStringArray, safeGet } from '../social-read.js';

/** Bounds that keep one resource section small; the full body is read with skill_read. */
export const MAX_LISTED_SKILLS = MAX_AGENT_SKILL_SELECTIONS;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const MAX_SKILL_ID_CHARS = 120;

/** Where a run reads skills from: the owner's store (for the agent record and the connections) and the skill store when there is Postgres. */
export interface SkillSource {
  platformSkills?: Pick<PlatformSkillsService, 'catalog'>;
  store: Store;
  /** The run's owner. Absent for a run without one: then no skill can load. */
  ownerId?: string;
  /** Absent without Postgres: then no selected skill can load, and each one is listed as unavailable. */
  skills?: SkillsService;
}

/** Metadata of a selected, loadable skill. */
export interface AuthorizedSkill {
  id: string;
  name: string;
  description: string;
}

/** A loadable skill with its instruction body, for skill_read and the home files. Never rendered into the section. */
export interface LoadedSkill extends AuthorizedSkill {
  versionId: string;
  instructions: string;
}

/** A selected id that cannot load now, kept visible instead of silently dropped. */
export interface SkillProblem {
  id: string;
  reason: 'unavailable';
}

export interface SkillSelection {
  selectedIds: string[];
}

export interface ResolvedSkills {
  authorized: LoadedSkill[];
  problems: SkillProblem[];
  /** Distinct selected ids beyond the bounded examination cap: counted, never fetched or rendered. */
  omitted: number;
}

/** Cap a stored string at `max` code units, marking real truncation instead of dropping it silently. */
export function bound(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function selectionFrom(agent: object): SkillSelection {
  return {
    selectedIds: readStringArray(agent, 'skillIds') ?? [],
  };
}

/** The agent's selected ids, or null when the agent record is missing or unreadable. */
export async function readSkillSelection(store: Store, agentId: string): Promise<SkillSelection | null> {
  const agent = await safeGet(store, 'agents', agentId);
  if (agent.status !== 'ok') return null;
  return selectionFrom(agent.doc);
}

/** Catalog ids of the owner's connected connectors. A skill that needs one does not load while it is not connected. */
export async function connectedCatalogIds(store: Store, ownerId: string): Promise<Set<string>> {
  const connected = new Set<string>();
  for (const connection of await listAll(store, 'connections')) {
    if (docOwner(connection) !== ownerId) continue;
    if (connection.status === 'connected' && connection.enabled !== false && connection.catalogId) connected.add(connection.catalogId);
  }
  return connected;
}

/**
 * The selected skills that may load now, with their bodies. Distinct ids are bounded by the schema cap: a legacy row with more selections
 * stays bounded instead of turning one context build into an unbounded number of reads. A failing skill store lists every id as unavailable.
 */
export async function resolveSelectedSkills(source: SkillSource, selection: SkillSelection, agentId: string): Promise<ResolvedSkills> {
  const distinct = [...new Set(selection.selectedIds)];
  const examined = distinct.slice(0, MAX_LISTED_SKILLS);
  const omitted = distinct.length - examined.length;
  const unavailable = (): ResolvedSkills => ({ authorized: [], problems: examined.map((id) => ({ id, reason: 'unavailable' as const })), omitted });
  const ownerId = source.ownerId;
  if (source.skills === undefined || ownerId === undefined || examined.length === 0) return unavailable();
  try {
    const loadable = await source.skills.loadable(ownerId, agentId, examined, await connectedCatalogIds(source.store, ownerId));
    const found = new Map(loadable.map((skill) => [skill.id, skill]));
    const authorized: LoadedSkill[] = [];
    for (const id of examined) {
      const skill = found.get(id);
      if (skill !== undefined) authorized.push({ id: skill.id, name: skill.name, description: skill.description, versionId: skill.versionId, instructions: skill.instructions });
    }
    const problems = examined.filter((id) => !found.has(id)).map((id) => ({ id, reason: 'unavailable' as const }));
    return { authorized, problems, omitted };
  } catch {
    return unavailable();
  }
}

function skillLine(skill: AuthorizedSkill): string {
  const name = bound(skill.name, MAX_SKILL_NAME_CHARS).replace(/\s+/g, ' ');
  const description = bound(skill.description, MAX_SKILL_DESCRIPTION_CHARS).replace(/\s+/g, ' ');
  return harnessText('skills.line', { name, description });
}

function problemLine(problem: SkillProblem): string {
  return harnessText('skills.problem', { id: quoteId(bound(problem.id, MAX_SKILL_ID_CHARS)) });
}

/**
 * Render loadable metadata plus fail-visible denials. Skills are agent-selected task instructions:
 * usable for the task, subordinate to the system instructions and the user's messages, and never able
 * to change identity or authorization. The body is read by name with skill_read.
 */
export function renderSkillSection(resolved: ResolvedSkills, agentId: string): string {
  void agentId;
  const lines = [harnessText('skills.selected.heading'), harnessText('skills.selected.intro')];
  const listed = resolved.authorized.slice(0, MAX_LISTED_SKILLS);
  for (const skill of listed) lines.push(skillLine(skill));
  for (const problem of resolved.problems) lines.push(problemLine(problem));
  const omitted = resolved.omitted + (resolved.authorized.length - listed.length);
  if (omitted > 0) {
    lines.push(harnessText('skills.selected.omitted', { count: String(omitted) }));
  }
  lines.push(harnessText('skills.selected.guidance'));
  return lines.join('\n');
}

/** The platform skills every agent has (BACKEND 5.1): name and description; the body is read with skill_read. */
export function renderPlatformSkillSection(skills: readonly Pick<PlatformSkill, 'name' | 'description'>[]): string {
  if (skills.length === 0) return '';
  const lines = [harnessText('skills.platform.heading'), harnessText('skills.platform.intro')];
  for (const skill of skills.slice(0, MAX_LISTED_SKILLS)) {
    const name = bound(skill.name, MAX_SKILL_NAME_CHARS).replace(/\s+/g, ' ');
    lines.push(harnessText('skills.line', { name, description: bound(skill.description, MAX_SKILL_DESCRIPTION_CHARS).replace(/\s+/g, ' ') }));
  }
  if (skills.length > MAX_LISTED_SKILLS) lines.push(harnessText('skills.platform.omitted', { count: String(skills.length - MAX_LISTED_SKILLS) }));
  return lines.join('\n');
}

/** The skills section: the agent's selected skills, then the platform skills. '' when the agent has neither. */
export async function buildSkillsSection(source: SkillSource, agentId: string, platform: readonly PlatformSkill[] = []): Promise<string> {
  return [await buildSelectedSkillsSection(source, agentId), await buildPlatformSkillSection(source.platformSkills, platform)].filter((part) => part.length > 0).join('\n\n');
}

/** The `## Selected skills` section, or '' when the agent has no configured skills. */
async function buildSelectedSkillsSection(source: SkillSource, agentId: string): Promise<string> {
  const agent = await safeGet(source.store, 'agents', agentId);
  if (agent.status === 'missing') return '';
  if (agent.status === 'error') {
    return harnessText('skills.selected.heading') + '\n' + harnessText('skills.selected.unreadable');
  }
  const selection = selectionFrom(agent.doc);
  if (selection.selectedIds.length === 0) return '';
  const resolved = await resolveSelectedSkills(source, selection, agentId);
  return renderSkillSection(resolved, agentId);
}

/** Database metadata wins case-insensitively; snapshot metadata supports legacy/offline services. */
async function buildPlatformSkillSection(source: Pick<PlatformSkillsService, 'catalog'> | undefined, fallback: readonly PlatformSkill[]): Promise<string> {
  let metadata: Array<Pick<PlatformSkill, 'name' | 'description'>> = [];
  let unavailable = false;
  try {
    metadata = await source?.catalog?.() ?? [];
  } catch {
    unavailable = true;
  }
  const merged = new Map<string, Pick<PlatformSkill, 'name' | 'description'>>();
  for (const skill of [...metadata, ...fallback]) {
    const key = skill.name.trim().toLowerCase();
    if (key === '' || merged.has(key)) continue;
    merged.set(key, { name: skill.name, description: skill.description });
  }
  const section = renderPlatformSkillSection([...merged.values()]);
  if (!unavailable) return section;
  return [section, 'Platform skill catalog unavailable; only snapshot metadata, if present, is listed.'].filter(Boolean).join('\n');
}
