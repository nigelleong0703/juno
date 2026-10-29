// The memory section (BACKEND §5.3, batch 5a): the items a presence may see, grouped; past 40 items the newest 15 in the section, and the 8
// best matches to the first message of a run in that run's note.
import { describe, expect, it } from 'vitest';
import type { VisibleItem } from '@agent-desktop/memory-graph/memory';
import { relevantItems, renderMemorySection, sectionItems, sectionLine, SECTION_ALL_MAX, type SectionLabels } from '../section.js';

const labels: SectionLabels = {
  people: new Map([['per_owner', 'Robin'], ['per_alice', 'Alice']]),
  agents: new Map([['agt-1', 'Juno']]),
  groups: new Map([['telegram-abc', 'Family chat']]),
};

function item(over: Partial<VisibleItem> & { id: string; text: string }): VisibleItem {
  return {
    ownerId: 'owner', kind: 'fact', file: 'memory', topic: null, aboutPersonId: 'per_owner', agentId: null, saidByPersonId: 'per_owner', saidByAccountId: null,
    saidByAgentId: null, saidIn: 'app', audience: 'owner', sensitive: false, status: 'active', claimId: null, evidence: null, legacyRef: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

describe('one line of the section', () => {
  it('says what it is, who said it and where', () => {
    expect(sectionLine(item({ id: 'a', text: 'Lives in   Leiden.\n' }), labels)).toBe('- Lives in Leiden. (said by Robin in app)');
    expect(sectionLine(item({ id: 'b', text: 'Likes tea.', saidIn: 'dm:telegram', audience: 'owner' }), labels)).toBe('- Likes tea. (said by Robin in your DM)');
    expect(sectionLine(item({ id: 'c', text: 'Wants short replies.', saidIn: 'group:telegram-abc', audience: 'group:telegram-abc', saidByPersonId: 'per_alice' }), labels)).toBe('- Wants short replies. (said by Alice in group Family chat)');
    expect(sectionLine(item({ id: 'd', text: 'Plans a trip.', saidByPersonId: null, saidByAgentId: 'agt-1', saidIn: 'app' }), labels)).toBe('- Plans a trip. (said by Juno (its note) in app)');
    expect(sectionLine(item({ id: 'e', text: 'Old fact.', saidByPersonId: null, saidIn: 'migrated' }), labels)).toBe('- Old fact. (said by someone in an earlier chat)');
  });
});

describe('the section text', () => {
  const owner = { kind: 'owner' as const };
  const base = { labels, ownerPersonId: 'per_owner', people: [], canNote: false };

  it('groups an owner\'s items by subject, with the people by name, and points at search and explain', () => {
    const items = [
      item({ id: '1', text: 'Lives in Leiden.' }),
      item({ id: '2', text: 'Prefers short answers.', file: 'bank:preferences', kind: 'preference' }),
      item({ id: '3', text: 'Greets by name.', file: 'person', aboutPersonId: 'per_alice', saidByPersonId: null, saidByAgentId: 'agt-1' }),
      item({ id: '4', text: 'Moved last spring.', file: 'bank:circumstances', kind: 'circumstance' }),
    ];
    const text = renderMemorySection({ ...base, presence: owner, items, people: [{ id: 'per_alice', name: 'Alice' }], canNote: true });
    expect(text).toBe([
      '## Memory',
      '',
      "### About Robin (the person you're helping)",
      '- Lives in Leiden. (said by Robin in app)',
      '- Prefers short answers. (said by Robin in app)',
      '- Moved last spring. (said by Robin in app)',
      '',
      '### About Alice',
      '- Greets by name. (said by Juno (its note) in app)',
      '',
      '### People pages',
      '- Alice (per_alice): /juno/people/per_alice.md',
      '',
      'More is remembered than is shown here: find it with memory_search, and see why a line is there, who said it and where, with memory_explain (give the [mem:...] or [claim:...] tag).',
      'When the person you are helping tells you who they are, what they do, about people in their life, an ongoing situation or how they want things, call memory_note in that same turn (about "user" for them, or the other person\'s name), one short note per fact: no subject for them ("Wants to cut sugar"), a name for anyone else ("Priya manages Tom"), never "me" or "you"; not for requests, venting or chit-chat. Details in /juno/docs/memory.md.',
      'You cannot delete memory; when they want something forgotten, tell them to remove it on the memory page.',
    ].join('\n'));
  });

  it('says what the group has said, with no owner-only lines', () => {
    const text = renderMemorySection({ ...base, presence: { kind: 'group', groupKey: 'telegram-abc' }, items: [item({ id: '5', text: 'Meeting at 6.', audience: 'group:telegram-abc', saidIn: 'group:telegram-abc', saidByPersonId: 'per_alice' })], canNote: true });
    expect(text.split('\n')[0]).toBe('## What this group has said (shared with everyone here)');
    expect(text).toContain('### About Robin (the owner)');
    expect(text).not.toContain("the person you're helping");
    expect(text).toContain('- Meeting at 6. (said by Alice in group Family chat)');
    expect(text).not.toContain('memory_note');
    expect(text).not.toContain('People pages');
    expect(text).toContain('memory_search finds more of it.');
  });

  it('says public for a run of someone else with no group, and lists only public items there', () => {
    const text = renderMemorySection({ ...base, presence: { kind: 'other' }, items: [item({ id: '6', text: 'The shop opens at nine.', audience: 'public', saidIn: 'app', aboutPersonId: null, file: 'memory', saidByPersonId: null })] });
    expect(text.split('\n')[0]).toBe('## Public memory (anyone may hear it)');
    expect(text).toContain('- The shop opens at nine. (said by someone in app)');
    expect(text).not.toContain('memory_note');
    expect(text).not.toContain('What this group');
  });

  it('is empty for a run with nothing to say, and says so for an owner with nothing yet', () => {
    expect(renderMemorySection({ ...base, presence: { kind: 'other' }, items: [] })).toBe('');
    expect(renderMemorySection({ ...base, presence: owner, items: [] })).toBe('');
    expect(renderMemorySection({ ...base, presence: owner, items: [], canNote: true })).toContain('Nothing is remembered yet.');
  });
});

describe('which items the section lists', () => {
  it('lists every item up to the limit', () => {
    const items = Array.from({ length: SECTION_ALL_MAX }, (_, i) => item({ id: 'i' + String(i), text: 'Item ' + String(i) }));
    expect(sectionItems(items)).toHaveLength(SECTION_ALL_MAX);
  });

  it('past the limit: only the newest 15, whatever the wake says', () => {
    const older = Array.from({ length: 40 }, (_, i) => item({ id: 'o' + String(i), text: 'Old note ' + String(i), createdAt: '2026-01-01T00:00:' + String(10 + i) + 'Z' }));
    const recent = Array.from({ length: 15 }, (_, i) => item({ id: 'r' + String(i), text: 'Recent ' + String(i), createdAt: '2026-06-01T00:00:0' + String(i % 10) + 'Z' }));
    expect(sectionItems([...older, ...recent]).map((entry) => entry.id)).toEqual(recent.map((entry) => entry.id));
  });

  it('the relevant items past the limit are the older ones that match the wake, and skip what was delivered already', async () => {
    const older = Array.from({ length: 40 }, (_, i) => item({ id: 'o' + String(i), text: 'Old note ' + String(i), createdAt: '2026-01-01T00:00:' + String(10 + i) + 'Z' }));
    const cycling = item({ id: 'bike', text: 'Rides a bike to work every day, cycling in the rain.', createdAt: '2026-01-02T00:00:00Z' });
    const recent = Array.from({ length: 15 }, (_, i) => item({ id: 'r' + String(i), text: 'Recent ' + String(i), createdAt: '2026-06-01T00:00:0' + String(i % 10) + 'Z' }));
    const all = [...older, cycling, ...recent];
    const relevant = await relevantItems(undefined, all, 'do you still go cycling?', new Set());
    // Only one older item shares a word with the wake: it is the only relevant one. The recent ones are in the section, not here.
    expect(relevant.map((entry) => entry.id)).toEqual(['bike']);
    expect(await relevantItems(undefined, all, 'do you still go cycling?', new Set(['bike']))).toEqual([]);
    expect(await relevantItems(undefined, all.slice(0, 20), 'cycling', new Set())).toEqual([]);
  });
});
