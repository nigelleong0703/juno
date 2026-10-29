/** When a digest runs (gate.ts): a direct chat reads one owner message of 8+ characters that is not an acknowledgement; a group needs 40 characters. */
import { describe, expect, it } from 'vitest';
import { isAcknowledgement, worthDigesting } from '../gate.js';

const owner = (text: string) => ({ role: 'user', text });
const other = (text: string) => ({ role: 'other', text });

describe('acknowledgements', () => {
  it('treats thanks, yes, laughter, emoji-only and the Chinese short replies as nothing new', () => {
    for (const text of ['ok', 'ok thanks', 'Thanks!!', 'thank you', 'yes.', 'hahaha', '哈哈哈', '呵呵', '好的', '谢谢', '收到', '👍', '😂😂', '...']) {
      expect(isAcknowledgement(text), text).toBe(true);
    }
  });

  it('does not treat a fact, however short, as an acknowledgement', () => {
    for (const text of ["Tom is Priya's manager", 'I moved to Lyon', '我下周去北京', 'no meat please']) {
      expect(isAcknowledgement(text), text).toBe(false);
    }
  });
});

describe('worthDigesting', () => {
  it('a direct chat runs on one owner message of 8+ characters that says something', () => {
    expect(worthDigesting([owner("Tom is Priya's manager")], true)).toBe(true);
    expect(worthDigesting([owner('ok thanks'), owner('hahaha'), owner('好的')], true)).toBe(false);
    expect(worthDigesting([owner('short')], true)).toBe(false);
  });

  it('a direct chat does not need 40 characters in total', () => {
    expect(worthDigesting([owner('Tom is Priya\'s manager.'), owner('ok')], true)).toBe(true);
  });

  it('a group runs on one message of 16+ characters that says something, however short the rest', () => {
    expect(worthDigesting([other('We\'ll ship the release on Friday.')], false)).toBe(true);
    expect(worthDigesting([other('Ship it Friday.')], false)).toBe(false);
    expect(worthDigesting([other('ok'), other('thanks'), other('great')], false)).toBe(false);
    expect(worthDigesting([other('haha haha haha haha haha'), other('ok')], false)).toBe(false);
  });

  it('a group also runs when its people write 40 characters together, short lines adding up', () => {
    expect(worthDigesting([other('Dinner on Friday with Ben'), other('at 7pm, let us book the table'), other('ok')], false)).toBe(true);
    expect(worthDigesting([other('Dinner Friday?'), other('Ben: yes'), other('Amy: sure')], false)).toBe(false);
  });
});
