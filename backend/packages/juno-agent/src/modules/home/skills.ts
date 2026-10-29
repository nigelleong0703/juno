/**
 * Selected skills as files (BACKEND §5.1): the versioned skill store stays the truth, this is its projection to
 * `agents/<id>/skills/<slug>/SKILL.md` for the agent to read with files.read. Only what loads now is projected.
 */
import { readSkillSelection, resolveSelectedSkills, type AuthorizedSkill, type SkillSource } from '../../execution/brain/resources/skills.js';
import { skillPath, skillSlugs } from './paths.js';

/** The SKILL.md text: frontmatter the agent can skim, then the stored instructions. */
export function renderSkillFile(skill: AuthorizedSkill, instructions: string): string {
  const one = (text: string) => JSON.stringify(text.replace(/\s+/g, ' ').trim());
  return '---\nname: ' + one(skill.name) + '\ndescription: ' + one(skill.description) + '\n---\n' + instructions.trim() + '\n';
}

/** path -> content for every skill this agent selected and may use now. */
export async function skillFiles(source: SkillSource, agentId: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const selection = await readSkillSelection(source.store, agentId);
  if (selection === null) return files;
  const resolved = await resolveSelectedSkills(source, selection, agentId);
  const slugs = skillSlugs(resolved.authorized);
  for (const skill of resolved.authorized) {
    files.set(skillPath(agentId, slugs.get(skill.id) ?? skill.id), renderSkillFile(skill, skill.instructions));
  }
  return files;
}
