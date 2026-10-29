import { describe, expect, it } from 'vitest';
import { alignmentFor } from '../../home/render.js';
import { appendedText } from '../../home/sync.js';
import { localDate } from '../../home/paths.js';
import { claimIdOfLine } from '../claims.js';
import { itemLine, viewPathOf } from '../views.js';
import { repeatsRetracted, repeatsText, verifyEvidence } from '../evidence.js';
import { sanitizeAlignment } from '../jobs/alignment.js';
import { nextHourlyAt, nightlyDue } from '../jobs/schedule.js';
import { computeStyleStats, type StatItem } from '../jobs/stats.js';
import { targetFile } from '../jobs/claims.js';
import { rankEntries, tokenize } from '../rank.js';

describe('quote verification and retraction', () => {
  const sources = new Map([['itm-1', 'I moved to Leiden last spring, and I hate mornings.'], ['log:memory/2026-10-14/a.md', '- 09:10 Alice has a cat named Miso']]);

  it('keeps only evidence whose quote is verbatim in its own message, and never a daily log', () => {
    const kept = verifyEvidence([
      { itemId: 'itm-1', quote: ' moved to Leiden ' },
      { itemId: 'itm-1', quote: 'moved to Amsterdam' },
      { itemId: 'itm-2', quote: 'moved to Leiden' },
      { itemId: 'log:memory/2026-10-14/a.md', quote: ' cat named Miso ' },
    ], sources);
    expect(kept).toEqual([{ itemId: 'itm-1', quote: 'moved to Leiden' }]);
  });

  it('recognizes a retracted claim reworded, or resting on the same words; an unrelated claim with the same message passes dedupe', () => {
    const gone = [{ text: 'Alice lives in Leiden.', evidence: [{ itemId: 'itm-1', quote: 'moved to Leiden' }] }];
    expect(repeatsRetracted({ text: 'alice lives in leiden', evidence: [{ itemId: 'itm-9', quote: 'x' }] }, gone)).toBe(true);
    expect(repeatsRetracted({ text: 'Alice moved last spring', evidence: [{ itemId: 'itm-1', quote: 'moved to Leiden' }] }, gone)).toBe(true);
    expect(repeatsRetracted({ text: 'Alice hates mornings', evidence: [{ itemId: 'itm-1', quote: 'hate mornings' }] }, gone)).toBe(false);
    expect(repeatsText({ text: 'Alice hates mornings', evidence: [{ itemId: 'itm-1', quote: 'moved to Leiden' }] }, gone)).toBe(false);
  });
});

describe('claim lines', () => {
  it('renders an item as one line, tagged with its claim or with its own id, and finds the file it belongs in', () => {
    expect(itemLine({ id: 'mem_1', text: 'Hates\nmornings [claim:old]', claimId: 'clm_b' })).toBe('- Hates mornings [claim:clm_b]');
    expect(itemLine({ id: 'mem_2', text: 'Has a cat', claimId: null })).toBe('- Has a cat [mem:mem_2]');
    expect(claimIdOfLine('- text [claim:clm_c]')).toBe('clm_c');
    expect(claimIdOfLine('- no tag')).toBeUndefined();
    expect(viewPathOf({ file: 'memory', aboutPersonId: null })).toBe('MEMORY.md');
    expect(viewPathOf({ file: 'bank:preferences', aboutPersonId: null })).toBe('memory/bank/preferences.md');
    expect(viewPathOf({ file: 'person', aboutPersonId: 'per_' + 'a'.repeat(32) })).toBe('people/per_' + 'a'.repeat(32) + '.md');
    expect(viewPathOf({ file: 'person', aboutPersonId: null })).toBeUndefined();
  });

  it('files a claim by its target: a person\'s page is people/<personId>.md, headed by the name, and only for a known person', () => {
    const people = [
      { id: 'per_3f2a1b2c' + '0'.repeat(24), name: 'Dr. Jan de Vries' },
      { id: 'per_9e8d7c6b' + '0'.repeat(24), name: '王小明' },
      { id: 'per_11111111' + '0'.repeat(24), name: 'Sam' },
      { id: 'per_22222222' + '0'.repeat(24), name: 'Sam' },
    ];
    expect(targetFile('memory')).toEqual({ path: 'MEMORY.md', file: 'memory', kind: 'fact' });
    expect(targetFile('Preferences')).toEqual({ path: 'memory/bank/preferences.md', file: 'bank:preferences', kind: 'preference' });
    // By id, full or as the header shows it; by name when exactly one person has it.
    expect(targetFile('person:per_3f2a1b2c' + '0'.repeat(24), people)).toEqual({ path: 'people/per_3f2a1b2c' + '0'.repeat(24) + '.md', file: 'person', kind: 'fact', personId: 'per_3f2a1b2c' + '0'.repeat(24) });
    expect(targetFile('person:per_3f2a1b2c', people)?.path).toBe('people/per_3f2a1b2c' + '0'.repeat(24) + '.md');
    expect(targetFile('person:王小明', people)?.path).toBe('people/per_9e8d7c6b' + '0'.repeat(24) + '.md');
    // A name that two people share, a name nobody has, and a person not in the list are all dropped: no page is started for them.
    expect(targetFile('person:Sam', people)).toBeUndefined();
    expect(targetFile('person:Nobody', people)).toBeUndefined();
    expect(targetFile('person:per_ffffffff', people)).toBeUndefined();
    expect(targetFile('person:Dr. Jan de Vries')).toBeUndefined();
    expect(targetFile('elsewhere')).toBeUndefined();
  });
});

describe('search ranking', () => {
  const vec = (x: number, y: number): number[] => [x, y];
  const entries = [
    { id: 'cat', text: 'Alice has a cat named Miso', embedding: vec(1, 0) },
    { id: 'job', text: 'Alice works as a nurse in Leiden', embedding: vec(0, 1) },
    { id: 'zh', text: '爱丽丝在莱顿做护士', embedding: vec(0.1, 0.9) },
  ];

  it('ranks by keywords alone without vectors, Chinese included', () => {
    expect(rankEntries('nurse', entries, undefined, 5).map((hit) => hit.id)).toEqual(['job']);
    expect(rankEntries('护士', entries, undefined, 5).map((hit) => hit.id)).toEqual(['zh']);
    expect(rankEntries('unrelated', entries, undefined, 5)).toEqual([]);
    expect(tokenize('莱顿ab Cd')).toEqual(['莱', '顿', '莱顿', 'ab', 'cd']);
  });

  it('merges vector and keyword hits: a meaning-only match appears and a double match wins', () => {
    const merged = rankEntries('nurse', entries, vec(0, 1), 5).map((hit) => hit.id);
    expect(merged[0]).toBe('job');
    expect(merged).toContain('zh');
    expect(merged).not.toContain('cat');
    expect(rankEntries('nurse', entries, vec(0, 1), 1)).toHaveLength(1);
  });
});

describe('how the user writes (counted)', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 14, 8, minute)).toISOString();
  const item = (id: string, minute: number, role: 'user' | 'agent', text: string, extra: Partial<StatItem> = {}): StatItem => ({ id, conversationId: 'c1', at: at(minute), role, text, ...extra });

  it('counts length, script, emoji, bursts and the fate of proactive messages', () => {
    const stats = computeStyleStats([
      item('1', 0, 'user', 'ok'),
      item('2', 1, 'user', '好的，谢谢！😀'),
      item('3', 2, 'agent', 'Morning briefing', { proactive: true }),
      item('4', 3, 'user', 'x'.repeat(250) + '.'),
      item('5', 4, 'agent', 'Reminder', { proactive: true }),
    ], new Date(Date.UTC(2026, 9, 14, 20, 0)));
    expect(stats.userMessages).toBe(3);
    expect(stats.chars.median).toBe(7);
    expect(stats.lengthShare).toEqual({ short: 0.667, medium: 0, long: 0.333 });
    expect(stats.emojiPerMessage).toBe(0.33);
    expect(stats.burstShare).toBe(0.333);
    expect(stats.scriptShare.cjk).toBeGreaterThan(0);
    expect(stats.exclamationShare).toBe(0.333);
    expect(stats.proactive).toEqual({ sent: 2, replied: 1, ignored: 1, pending: 0 });
    expect(computeStyleStats([], new Date()).userMessages).toBe(0);
  });
});

describe('alignment synthesis', () => {
  const text = '# How to talk\n- Short. [claim:clm_a]\n- Formal. [claim:clm_gone]\n- Odd. [claim:clm_ghost]\n## Juno（agt-1）\n- Use Dutch.\n## Ghost（agt-9）\n- Secret.\n## Style\n- Plain.';

  it('gives an agent the shared part plus its own section only', () => {
    expect(alignmentFor(text, 'agt-1')).toContain('Use Dutch.');
    expect(alignmentFor(text, 'agt-1')).not.toContain('Secret.');
    expect(alignmentFor(text, 'agt-2')).not.toContain('Use Dutch.');
    expect(alignmentFor(text, 'agt-2')).toContain('Plain.');
  });

  it('drops lines on retracted claims, tags that do not exist, and sections of agents that are gone', () => {
    const clean = sanitizeAlignment(text, { agentIds: new Set(['agt-1']), statuses: new Map([['clm_a', 'active'], ['clm_gone', 'retracted']]) });
    expect(clean).toContain('- Short. [claim:clm_a]');
    expect(clean).not.toContain('Formal.');
    expect(clean).toContain('- Odd.\n');
    expect(clean).not.toContain('clm_ghost');
    expect(clean).toContain('Use Dutch.');
    expect(clean).not.toContain('Secret.');
    expect(clean).toContain('Plain.');
  });
});

describe('schedule and clocks', () => {
  it('fires at the owner\'s minute of the next hour and runs the nightly job once in the 3 a.m. hour', () => {
    const now = new Date('2026-10-14T10:20:00Z');
    const next = nextHourlyAt(now, 'owner-1');
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(3_600_000);
    expect(nextHourlyAt(next, 'owner-1').getTime() - next.getTime()).toBe(3_600_000);
    expect(nightlyDue(new Date('2026-10-14T19:30:00Z'), 'Asia/Shanghai', undefined)).toEqual({ due: true, date: '2026-10-15' });
    expect(nightlyDue(new Date('2026-10-14T19:30:00Z'), 'Asia/Shanghai', '2026-10-15').due).toBe(false);
    expect(nightlyDue(new Date('2026-10-14T10:30:00Z'), 'Asia/Shanghai', undefined).due).toBe(false);
    expect(localDate(new Date('2026-10-14T23:30:00Z'), 'Asia/Shanghai')).toBe('2026-10-15');
    expect(localDate(new Date('2026-10-14T23:30:00Z'))).toBe('2026-10-14');
  });
});

describe('what an agent appended', () => {
  it('returns the tail of an appended file, or the new lines of a rewritten one', () => {
    expect(appendedText('- a\n', '- a\n- b\n')).toBe('- b\n');
    expect(appendedText('- a\n- b\n', '- b\n- c\n')).toBe('- c\n');
    expect(appendedText('', '- first\n')).toBe('- first\n');
  });
});
