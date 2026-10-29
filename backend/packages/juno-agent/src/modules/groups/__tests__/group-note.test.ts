// The group note file (BACKEND §5.7.9): its format, its keys and its sections. The chat digest that writes the About is tested in
// modules/digest/__tests__/chat-digest.test.ts.
import { describe, expect, it } from 'vitest';
import { aboutIsStale, aboutOf, groupNoteKey, groupNotePath, groupNoteSection, parseNote, renderNote, rulesOf, withAbout, withRule } from '../note.js';

const OWNER = 'owner-1';
const NOW = new Date('2026-10-22T10:00:00Z');
const CHAT = { kind: 'discord', channelId: 'chan', chatId: 'C1' };

describe('the note file', () => {
  it('round-trips, keeps sections it does not own, and never lets text forge a section', () => {
    const text = '# #dinner · Discord\n\n## About (as of 2026-10-01)\nFriends.\n\n## Owner\'s rules\n- Reply in English.\n\n## My own section\nkeep me\n';
    const doc = parseNote(text);
    expect(renderNote(doc)).toBe(text);
    expect(aboutOf(doc)).toEqual({ body: 'Friends.', at: '2026-10-01' });
    expect(rulesOf(doc)).toEqual(['Reply in English.']);
    const rewritten = renderNote(withAbout(doc, 'New summary.', '2026-10-22'));
    expect(rewritten).toContain('## About (as of 2026-10-22)\nNew summary.');
    expect(rewritten).toContain("- Reply in English.");
    expect(rewritten).toContain('## My own section\nkeep me');
  });

  it('rules: appended in order, a repeat is refused, the list is capped', () => {
    let doc = parseNote('');
    for (let i = 1; i <= 15; i += 1) {
      const next = withRule(doc, 'rule ' + String(i));
      if ('refused' in next) throw new Error('refused early');
      doc = next.doc;
    }
    expect(rulesOf(doc)).toHaveLength(15);
    expect(withRule(doc, 'RULE 3')).toEqual({ refused: 'duplicate' });
    expect(withRule(doc, 'one more')).toEqual({ refused: 'full' });
  });

  it('stale after a week or without a readable date; the section is empty until there is an About or a rule', () => {
    expect(aboutIsStale({ at: '2026-10-15' }, NOW)).toBe(true);
    expect(aboutIsStale({ at: '2026-10-16' }, NOW)).toBe(false);
    expect(aboutIsStale({}, NOW)).toBe(true);
    expect(groupNoteSection('# Chat\n')).toBe('');
    expect(groupNoteSection('# Chat\n\n## Owner\'s rules\n- Be brief.\n')).toContain("Owner's rules (a later rule wins over an earlier one):\n- Be brief.");
  });

  it('is one file per chat for every thread of it, and another file for another chat or owner', () => {
    expect(groupNoteKey(OWNER, CHAT)).toBe(groupNoteKey(OWNER, { ...CHAT }));
    expect(groupNotePath(OWNER, CHAT)).toMatch(/^groups\/discord-[0-9a-f]{12}\.md$/);
    expect(groupNotePath(OWNER, { ...CHAT, chatId: 'C2' })).not.toBe(groupNotePath(OWNER, CHAT));
    expect(groupNotePath('owner-2', CHAT)).not.toBe(groupNotePath(OWNER, CHAT));
  });
});
