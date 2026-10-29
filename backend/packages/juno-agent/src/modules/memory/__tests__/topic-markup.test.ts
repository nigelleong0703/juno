import { describe, expect, it } from 'vitest';
import { cleanMarkup, plainOf, segmentsOf } from '../topic-markup.js';

const known = (...ids: string[]) => (id: string) => ids.includes(id);

describe('topic summary markers', () => {
  it('turns [[id|phrase]] into tappable segments and keeps the text around them', () => {
    expect(segmentsOf("You're [[mem_a|building muscle]] and [[mem_b|cutting sugar]].", known('mem_a', 'mem_b'))).toEqual([
      { text: "You're " }, { text: 'building muscle', itemId: 'mem_a' }, { text: ' and ' }, { text: 'cutting sugar', itemId: 'mem_b' }, { text: '.' },
    ]);
    expect(segmentsOf('', known())).toEqual([]);
    expect(plainOf("You're [[mem_a|building muscle]].")).toBe("You're building muscle.");
  });

  it('an unknown or no longer active id keeps the phrase as plain text, joined to its neighbours', () => {
    expect(segmentsOf('You [[mem_x|like tea]] a lot.', known('mem_a'))).toEqual([{ text: 'You like tea a lot.' }]);
  });

  it('nested, unclosed and empty markers become text, never a broken link', () => {
    expect(segmentsOf('A [[mem_a|b [[mem_b|c]] d]] e', known('mem_a', 'mem_b'))).toEqual([{ text: 'A b ' }, { text: 'c', itemId: 'mem_b' }, { text: ' d e' }]);
    expect(segmentsOf('A [[mem_a|unclosed phrase', known('mem_a'))).toEqual([{ text: 'A unclosed phrase' }]);
    expect(segmentsOf('A [[mem_a|]]B', known('mem_a'))).toEqual([{ text: 'A B' }]);
    expect(segmentsOf('A [[no pipe]] B ]] C', known('mem_a'))).toEqual([{ text: 'A no pipe B  C' }]);
  });

  it('cleanMarkup stores only markers for the ids that were given, collapses whitespace and cuts the readable text, not the marker', () => {
    const allowed = new Set(['mem_a']);
    expect(cleanMarkup("You  like\n[[mem_a|tea]] and [[mem_zzz|cake]].", allowed, 600)).toBe('You like [[mem_a|tea]] and cake.');
    expect(cleanMarkup('Ab [[mem_a|tea time]] cd', allowed, 6)).toBe('Ab [[mem_a|tea]]');
    expect(cleanMarkup('[[mem_a|]]', allowed, 600)).toBe('');
  });
});
