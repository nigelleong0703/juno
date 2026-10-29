// PH6: a selected skill's body reaches the agent as a SKILL.md file in its home (BACKEND §5.1), authorized like before.
import { describe, expect, it } from 'vitest';
import { skillFiles } from '../../../modules/home/skills.js';
import { skillPath } from '../../../modules/home/paths.js';
import { createFakeSkills } from '../../../testing/skills.js';
import { AGENT, FIXTURE_SKILLS, PEER, agentDoc, seed } from './agent-resources.fixtures.js';

const OWNER = 'owner-1';

describe('PH6 selected skills are projected as files', () => {
  it('writes the full body of a selected, authorized skill and nothing else', async () => {
    const files = await skillFiles({ store: await seed(), ownerId: OWNER, skills: createFakeSkills(FIXTURE_SKILLS) }, AGENT);
    expect([...files.keys()].sort()).toEqual([skillPath(AGENT, 'alpha-skill'), skillPath(AGENT, 'beta-skill')]);
    const alpha = files.get(skillPath(AGENT, 'alpha-skill')) ?? '';
    expect(alpha).toContain('ALPHA-INSTRUCTIONS-FULL');
    expect(alpha).toContain('name: "Alpha Skill"');
    expect([...files.values()].join('\n')).not.toContain('FOREIGN-INSTRUCTIONS-FULL');
  });

  it("projects only the agent's own selection", async () => {
    const files = await skillFiles({ store: await seed(), ownerId: OWNER, skills: createFakeSkills(FIXTURE_SKILLS) }, PEER);
    expect([...files.keys()]).toEqual([skillPath(PEER, 'beta-skill')]);
  });

  it('keeps a very large body whole and gives repeated names distinct directories', async () => {
    const store = await seed();
    const body = 'Y'.repeat(50_000) + 'LAST';
    const skills = createFakeSkills([...FIXTURE_SKILLS, { id: 'skl-large', name: 'Beta Skill', description: 'Large.', instructions: body, ownerId: OWNER }]);
    await store.put('agents', agentDoc(AGENT, ['skl-beta', 'skl-large']));
    const files = await skillFiles({ store, ownerId: OWNER, skills }, AGENT);
    expect(files.get(skillPath(AGENT, 'beta-skill-2'))).toContain('Y'.repeat(50_000) + 'LAST');
    expect(files.size).toBe(2);
  });
});
