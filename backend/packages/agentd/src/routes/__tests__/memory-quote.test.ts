import { describe, expect, it } from 'vitest';
import { QUOTE_MAX, trimQuote } from '../memory-quote.js';

describe('trimQuote', () => {
  it('keeps a short quote as it is, trimmed', () => {
    expect(trimQuote('  I train four times a week \n')).toBe('I train four times a week');
  });

  it('cuts a long quote at a word within 280 characters and closes it with an ellipsis', () => {
    const cut = trimQuote('word '.repeat(100));
    expect(Array.from(cut).length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(cut.endsWith('word…')).toBe(true);
  });

  it('cuts text without spaces (Chinese) on a whole character, never inside a pair', () => {
    const cut = trimQuote('我每周训练四次，大多在早上。'.repeat(40) + '🙂'.repeat(300));
    expect(Array.from(cut).length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
