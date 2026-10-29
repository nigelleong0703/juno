// PH6: the run context carries bounded metadata for the current agent's selected skills only.
import { describe, expect, it } from 'vitest';
import {
  buildSkillsSection,
  MAX_LISTED_SKILLS,
  MAX_SKILL_DESCRIPTION_CHARS,
} from '../resources/skills.js';
import { createFakeSkills } from '../../../testing/skills.js';
import {
  AGENT,
  FIXTURE_SKILLS,
  PEER,
  agentDoc,
  failReadsOf,
  seed,
  systemContent,
} from './agent-resources.fixtures.js';

const OWNER = 'owner-1';

describe('PH6 selected skill resources in the run context', () => {
  it("lists only this agent's authorized selections as bounded metadata, never the bodies", async () => {
    const content = await systemContent(await seed(), AGENT);
    expect(content).toContain('## Selected skills (agent-selected task instructions)');
    expect(content).toContain('- Alpha Skill: Alpha procedures.');
    expect(content).toContain('- Beta Skill: Beta procedures.');
    // The body is read by name, so no path or home layout reaches the model.
    expect(content).toContain('skill_read(name)');
    expect(content).not.toContain('/skills/alpha-skill/SKILL.md');
    expect(content).toContain('subordinate to the system instructions');
    expect(content).not.toContain('ALPHA-INSTRUCTIONS-FULL');
    expect(content).not.toContain('BETA-INSTRUCTIONS-FULL');
    // No unsupported workspace-prompt claim and no implicit host instruction discovery.
    expect(content).not.toContain('workspace or project prompt');
    expect(content).not.toContain('AGENTS.md');
  });

  it("changing the agent's selection changes the provider context", async () => {
    const content = await systemContent(await seed(), PEER);
    expect(content).toContain('- Beta Skill:');
    expect(content).not.toContain('Alpha Skill');
    expect(content).not.toContain('skl-alpha');
  });

  it('keeps a missing selection visible as not loaded', async () => {
    const content = await systemContent(await seed(), AGENT);
    expect(content).toContain("skill 'skl-missing': not loaded now");
  });

  it('keeps a skill whose connector is not connected out of the section, without a body', async () => {
    const skills = createFakeSkills([
      ...FIXTURE_SKILLS,
      { id: 'skl-mail', name: 'Mail Skill', description: 'Mail procedures.', instructions: 'MAIL-BODY', ownerId: OWNER, deps: [{ type: 'connector', catalogId: 'gmail' }] },
    ]);
    const store = await seed();
    await store.put('agents', agentDoc(AGENT, ['skl-mail', 'skl-alpha']));
    const content = await systemContent(store, AGENT, skills);
    expect(content).not.toContain('Mail Skill');
    expect(content).not.toContain('MAIL-BODY');
    expect(content).toContain("skill 'skl-mail': not loaded now");
    expect(content).toContain('- Alpha Skill: Alpha procedures.');
  });

  it('stays bounded and never embeds a large instruction body', async () => {
    const store = await seed();
    const big = 'X'.repeat(21_000);
    const skills = createFakeSkills([...FIXTURE_SKILLS, { id: 'skl-large', name: 'Large Skill', description: 'D'.repeat(1000), instructions: big, ownerId: OWNER }]);
    await store.put('agents', agentDoc(AGENT, ['skl-large']));
    const content = await systemContent(store, AGENT, skills);
    expect(content).not.toContain('XXXXX');
    const line = content.split('\n').find((candidate) => candidate.includes('Large Skill'));
    expect(line).toBeDefined();
    expect(line ?? '').toContain('D'.repeat(MAX_SKILL_DESCRIPTION_CHARS) + '…');
    expect(line ?? '').not.toContain('D'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 1));
  });

  it('examines at most the cap of distinct selections and counts the rest as omitted', async () => {
    const store = await seed();
    const overflow = Array.from({ length: MAX_LISTED_SKILLS + 5 }, (_unused, index) => 'skl-miss-' + String(index));
    await store.put('agents', agentDoc(AGENT, overflow));
    const content = await systemContent(store, AGENT);
    const problems = content.split('\n').filter((line) => line.includes('not loaded now'));
    expect(problems).toHaveLength(MAX_LISTED_SKILLS);
    expect(content).toContain('5 more selected skills are not examined in this bounded section');
    expect(content).not.toContain('skl-miss-' + String(MAX_LISTED_SKILLS));
  });

  it('marks a skill store that cannot be read instead of dropping the selection silently', async () => {
    const skills = createFakeSkills(FIXTURE_SKILLS);
    const unreadable = { ...skills, loadable: async () => { throw new Error('skill store unreadable'); } };
    const content = await systemContent(await seed(), AGENT, unreadable);
    expect(content).toContain("skill 'skl-alpha': not loaded now");
    expect(content).not.toContain('Alpha Skill');
  });

  it('marks an unreadable agent record instead of inventing a selection', async () => {
    const section = await buildSkillsSection(
      { store: failReadsOf(await seed(), 'agents', AGENT), ownerId: OWNER, skills: createFakeSkills(FIXTURE_SKILLS) },
      AGENT,
    );
    expect(section).toContain('Skill resources unreadable');
    expect(section).not.toContain('skl-alpha');
  });
});
