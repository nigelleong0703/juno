/**
 * Shared bounded skill catalog for skill discovery and skill body reads.
 *
 * Two sources: agent-selected, owner-authorized stored metadata (via readSkillSelection /
 * resolveSelectedSkills), then every active platform skill's name and description from the
 * platform rows (PlatformSkillsService.catalog). Neither touches the computer, so search never
 * provisions anything. The platform part is complete: the prompt lists only a budgeted subset and
 * points here for the rest.
 *
 * Metadata only: labels and descriptions, never instruction bodies, so the full text is never
 * sent to Jev during search. Descriptions may truncate; read keys may not: readKey is always
 * an exact key skill_read accepts (the full name, or the skill id when the name exceeds the
 * read limit), while label is the bounded display text.
 */
import type { Store } from '../../../contracts/index.js';
import type { SkillsService } from '@agent-desktop/memory-graph/skills';
import { bound, MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_NAME_CHARS, readSkillSelection, resolveSelectedSkills, type SkillSource } from '../../../execution/brain/resources/skills.js';

/** One catalog row: an exact read key plus bounded display text. */
export interface SkillCatalogEntry {
  /** Exact key skill_read accepts: the full name when it fits the read limit, else the skill id. */
  readKey: string;
  /** Bounded one-line label; identical to readKey except for overlong names. */
  label: string;
  description: string;
}

export interface SkillCatalog {
  entries: SkillCatalogEntry[];
  /** Distinct selected ids beyond the bounded examination cap: counted, never fetched. */
  omitted: number;
}

/** Matches skill_read's input limit: a longer name cannot be passed back by name. */
const READ_KEY_CHARS = 120;

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

/**
 * Gather the agent-selected, owner-authorized skills. Never reads instruction bodies and never
 * touches the computer: without a selection the catalog is simply empty.
 */
/** The skill source of one tool call: the run's owner-scoped store, and the skill store when the process has one. */
export function skillSource(ctx: { store: Store; ownerId: string }, skills: SkillsService | undefined, platformSkills?: SkillSource['platformSkills']): SkillSource {
  return { store: ctx.store, ownerId: ctx.ownerId, ...(skills === undefined ? {} : { skills }), ...(platformSkills === undefined ? {} : { platformSkills }) };
}

export async function listSkillCatalog(source: SkillSource, agentId: string): Promise<SkillCatalog> {
  const entries: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  const selection = await readSkillSelection(source.store, agentId);
  if (selection !== null) {
    const resolved = await resolveSelectedSkills(source, selection, agentId);
    for (const skill of resolved.authorized) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const trimmed = skill.name.trim();
      const readKey = trimmed.length <= READ_KEY_CHARS ? trimmed : skill.id;
      const label = oneLine(bound(trimmed, MAX_SKILL_NAME_CHARS));
      entries.push({
        readKey,
        label,
        description: oneLine(bound(skill.description, MAX_SKILL_DESCRIPTION_CHARS)),
      });
    }
    omitted += resolved.omitted;
  }
  // Every active platform skill, not just the ones the prompt lists (its budget is the prompt's, not the search's). Metadata comes from the
  // platform rows, so this never touches the computer; a selected skill of the same name wins.
  for (const skill of await source.platformSkills?.catalog?.() ?? []) {
    const key = skill.name.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      readKey: skill.name.trim(),
      label: oneLine(bound(skill.name.trim(), MAX_SKILL_NAME_CHARS)),
      description: oneLine(bound(skill.description, MAX_SKILL_DESCRIPTION_CHARS)),
    });
  }
  return { entries, omitted };
}
