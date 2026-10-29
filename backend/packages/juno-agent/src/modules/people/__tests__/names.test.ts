/** Name matching (names.ts): the forms of "Priya" and "Tom" a model or a person writes must all reach the same person. */
import { describe, expect, it } from 'vitest';
import { displayName, nameKey } from '../names.js';

describe('nameKey', () => {
  it('matches "Priya" with its case, spacing, possessive and curly apostrophe', () => {
    for (const form of ['Priya', 'priya', ' Priya ', 'PRIYA', "Priya's", 'Priya’s', "priya's ", 'Priya​', 'Priya ']) {
      expect(nameKey(form), JSON.stringify(form)).toBe('priya');
    }
  });

  it('matches "Tom" with the same forms', () => {
    for (const form of ['Tom', ' tom', "Tom's", 'Tom’s']) {
      expect(nameKey(form), JSON.stringify(form)).toBe('tom');
    }
  });

  it('keeps different names apart', () => {
    expect(nameKey('Priya')).not.toBe(nameKey('Priyanka'));
    expect(nameKey('Tom')).not.toBe(nameKey('Tomas'));
  });
});

describe('displayName', () => {
  it('keeps the case and drops the possessive and quote marks, so a new person is named plainly', () => {
    expect(displayName("Priya's")).toBe('Priya');
    expect(displayName('“Tom”')).toBe('Tom');
    expect(displayName('  Zed  ')).toBe('Zed');
  });
});
