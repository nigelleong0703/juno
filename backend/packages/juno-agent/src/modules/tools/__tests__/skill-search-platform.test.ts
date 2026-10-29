/** skill_search covers every active platform skill, including the ones the prompt section leaves out because of its list budget. */
import { describe, expect, it } from 'vitest';
import { wakeEventSchema } from '../../../contracts/index.js';
import type { ToolContext } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { buildSkillsSection, MAX_LISTED_SKILLS } from '../../../execution/brain/resources/skills.js';
import { createSkillSearchTool } from '../tools/skillSearch.js';

function context(): ToolContext {
  return {
    ownerId: 'owner', agentId: 'agent', conversationId: 'conversation', runId: 'run',
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'wake', ownerId: 'owner', agentId: 'agent', conversationId: 'conversation', sessionKey: 'agent:conversation', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: new Date().toISOString() }),
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
  };
}

describe('skill_search over platform skills', () => {
  const rows = [
    ...Array.from({ length: MAX_LISTED_SKILLS + 4 }, (_, index) => ({ name: 'filler-' + String(index).padStart(2, '0'), description: 'Generic helper number ' + index })),
    { name: 'zebra-tracker', description: 'Track zebra migration herds' },
  ];
  const platformSkills = { catalog: async () => rows };

  it('finds a skill that the prompt section does not list', async () => {
    const prompt = await buildSkillsSection({ store: createMemoryStore(), platformSkills }, 'agent');
    expect(prompt).not.toContain('zebra-tracker');
    expect(prompt).toContain('5 more platform skills');
    const result = await createSkillSearchTool({ platformSkills }).execute({ query: 'zebra' }, context());
    const text = JSON.stringify(result.content);
    expect(text).toContain('- zebra-tracker: Track zebra migration herds');
    expect(text.indexOf('zebra-tracker')).toBeLessThan(text.indexOf('filler-'));
  });
});
