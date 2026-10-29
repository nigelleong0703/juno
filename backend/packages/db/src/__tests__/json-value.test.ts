import { describe, expect, it } from 'vitest';
import { toJsonValue } from '../guards.js';

describe('toJsonValue', () => {
  it('replaces NUL characters, which jsonb rejects, anywhere in a document', () => {
    const doc = { id: 'x', output: 'PDF\u0000bytes', nested: [{ text: '\u0000\u0000ok' }] };
    expect(toJsonValue(doc)).toEqual({ id: 'x', output: 'PDF\uFFFDbytes', nested: [{ text: '\uFFFD\uFFFDok' }] });
  });

  it('leaves ordinary strings untouched, including an escaped backslash-u sequence', () => {
    expect(toJsonValue({ text: 'C:\\u0000 is text, not a NUL' })).toEqual({ text: 'C:\\u0000 is text, not a NUL' });
  });
});
