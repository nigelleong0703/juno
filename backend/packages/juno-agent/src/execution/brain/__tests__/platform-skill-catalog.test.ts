import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { subagentSessionKey } from '../../../modules/tasks/subagent.js';
import { createBrain } from '../index.js';
import { parseContext } from '../context.js';
import { buildSkillsSection, MAX_LISTED_SKILLS } from '../resources/skills.js';
import { contextText } from './context-text.js';

const metadata = { name: 'feed-article', description: 'Publish complete illustrated articles.' };

describe('platform skill catalog context', () => {
  it('production brain exposes metadata to root and child without a computer or body reads', async () => {
    const catalog = vi.fn(async () => [{ ...metadata, instructions: 'SECRET SKILL BODY' }]);
    const resolve = vi.fn();
    const recordUse = vi.fn();
    const platformSkills = { catalog, resolve, recordUse };
    const brain = await createBrain({ store: createMemoryStore(), blobs: createMemoryBlobStore(), platformSkills });
    for (const sessionKey of ['a:c', subagentSessionKey('a', 'c', 'child-1')]) {
      const context = await brain.buildContext({ agentId: 'a', conversationId: 'c', sessionKey, wake: [] });
      const text = contextText(parseContext(context));
      expect(text).toContain(metadata.name);
      expect(text).toContain(metadata.description);
      expect(text).not.toContain('SECRET SKILL BODY');
    }
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();
    expect(recordUse).not.toHaveBeenCalled();
  });

  it('new catalog metadata is read on subsequent builds', async () => {
    const catalog = vi.fn(async () => [metadata]);
    const source = { store: createMemoryStore(), platformSkills: { catalog } };
    const first = await buildSkillsSection(source, 'a');
    expect(first).toContain(metadata.description);
    catalog.mockResolvedValue([{ name: 'renamed-article', description: 'New authoritative description.' }]);
    const second = await buildSkillsSection(source, 'a');
    expect(second).toContain('renamed-article');
    expect(second).toContain('New authoritative description.');
    expect(second).not.toContain('feed-article');
  });

  it('says so on a catalog outage instead of listing nothing silently', async () => {
    const source = { store: createMemoryStore(), platformSkills: { catalog: async () => { throw new Error('offline'); } } };
    expect(await buildSkillsSection(source, 'a')).toContain('Platform skill catalog unavailable');
  });

  it('bounds merged counts and metadata without rendering extra fields', async () => {
    const rows = Array.from({ length: MAX_LISTED_SKILLS + 2 }, (_, index) => ({ name: 'skill-' + index, description: 'd'.repeat(1000), instructions: 'SECRET' }));
    const text = await buildSkillsSection({ store: createMemoryStore(), platformSkills: { catalog: async () => rows } }, 'a');
    expect(text).toContain('skill-' + (MAX_LISTED_SKILLS - 1));
    expect(text).not.toContain('skill-' + MAX_LISTED_SKILLS);
    expect(text).not.toContain('d'.repeat(241));
    expect(text).not.toContain('SECRET');
    expect(text).toContain('2 more platform skills are not listed here. Find them with skill_search(query), then read one with skill_read(name).');
  });

  it('lists everything with no omitted line while the catalog fits the budget', async () => {
    const rows = Array.from({ length: MAX_LISTED_SKILLS }, (_, index) => ({ name: 'skill-' + index, description: 'd' }));
    const text = await buildSkillsSection({ store: createMemoryStore(), platformSkills: { catalog: async () => rows } }, 'a');
    expect(text).toContain('skill-' + (MAX_LISTED_SKILLS - 1));
    expect(text).not.toContain('more platform skills');
  });
});
