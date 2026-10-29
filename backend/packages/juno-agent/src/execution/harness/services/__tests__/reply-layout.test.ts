import { describe, expect, it } from 'vitest';
import { uiDocToText } from '@agent-desktop/public-contracts';
import { closedBlocks, layoutReply, MAX_REPLY_BUBBLES } from '../reply-layout.js';

describe('closedBlocks (the bubbles of a reply still being written)', () => {
  it('releases a paragraph once its blank line is written, never the one being written', () => {
    expect(closedBlocks('First.')).toEqual([]);
    expect(closedBlocks('First.\n\nSec')).toEqual(['First.']);
    expect(closedBlocks('First.\n\nSecond.\n\n')).toEqual(['First.', 'Second.']);
  });

  it('holds a lead-in ending with a colon and the list that follows until the list is over', () => {
    expect(closedBlocks('Here is the plan:\n\n')).toEqual([]);
    expect(closedBlocks('Here is the plan:\n\n- one\n- two\n\n')).toEqual([]);
    expect(closedBlocks('Here is the plan:\n\n- one\n- two\n\nDone.')).toEqual(['Here is the plan:\n\n- one\n- two']);
    expect(closedBlocks('A.\n\n- one\n\n-')).toEqual(['A.']);
  });

  it('holds everything inside a code fence that spans chunks, and a document (table or heading)', () => {
    expect(closedBlocks('Code:\n\n```js\nconst a = 1;\n\nconst b = 2;')).toEqual([]);
    expect(closedBlocks('Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;')).toEqual(['Intro.']);
    expect(closedBlocks('Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.')).toEqual([]);
  });

  it('stops before a card, which attaches to the paragraph above it', () => {
    expect(closedBlocks('One.\n\nTwo.\n\n```card\n{"version":1')).toEqual(['One.']);
  });

  it('agrees with layoutReply on what the closed blocks are', () => {
    const text = 'One.\n\nIntro:\n\n- a\n- b\n\n- c\n\nLast.\n\nEnd.';
    const full = layoutReply(text).bubbles.map((bubble) => bubble.markdown);
    expect(closedBlocks(text)).toEqual(full.slice(0, closedBlocks(text).length));
    expect(closedBlocks(text + '\n\n')).toEqual(full);
  });
});

describe('layoutReply past the cap after bubbles were streamed', () => {
  it('keeps the first cap-1 bubbles and puts the rest into the last', () => {
    const paragraphs = Array.from({ length: MAX_REPLY_BUBBLES + 3 }, (_, i) => `Line ${i}.`);
    const bubbles = layoutReply(paragraphs.join('\n\n'), MAX_REPLY_BUBBLES - 1).bubbles.map((bubble) => bubble.markdown);
    expect(bubbles).toHaveLength(MAX_REPLY_BUBBLES);
    expect(bubbles.slice(0, MAX_REPLY_BUBBLES - 1)).toEqual(paragraphs.slice(0, MAX_REPLY_BUBBLES - 1));
    expect(bubbles[MAX_REPLY_BUBBLES - 1]).toBe(paragraphs.slice(MAX_REPLY_BUBBLES - 1).join('\n\n'));
  });
});

const CARD_JSON = JSON.stringify({ version: 1, title: 'Options', blocks: [{ type: 'facts', rows: [{ label: 'Price', value: '$10' }] }] });
const card = (body: string = CARD_JSON): string => '```card\n' + body + '\n```';
const markdowns = (text: string): string[] => layoutReply(text).bubbles.map((bubble) => bubble.markdown);

describe('layoutReply', () => {
  it('keeps a single greeting as one bubble and nothing as none', () => {
    expect(markdowns('Hey there!')).toEqual(['Hey there!']);
    expect(layoutReply('  \n \n').bubbles).toEqual([]);
  });

  it('makes each paragraph its own bubble', () => {
    expect(markdowns('One.\n\nTwo.\n\n\nThree.')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('keeps a lead-in ending with a colon together with what follows', () => {
    expect(markdowns('Here are the options:\n\n- a\n- b')).toEqual(['Here are the options:\n\n- a\n- b']);
  });

  it('keeps consecutive list blocks together', () => {
    expect(markdowns('- a\n- b\n\n- c\n\nDone.')).toEqual(['- a\n- b\n\n- c', 'Done.']);
    expect(markdowns('Pick one:\n\n- a\n\n- b\n\nOr skip.')).toEqual(['Pick one:\n\n- a\n\n- b', 'Or skip.']);
  });

  it('keeps a heading or table document as one bubble', () => {
    const doc = '# Report\n\nIntro.\n\n## Part\n\nMore.';
    expect(markdowns(doc)).toEqual([doc]);
    const table = 'Compare:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nPick one.';
    expect(markdowns(table)).toEqual([table]);
  });

  it('never splits inside a code fence', () => {
    const code = '```js\nconst a = 1;\n\nconst b = 2;\n```';
    expect(markdowns(`Run this.\n\n${code}\n\nThen tell me.`)).toEqual(['Run this.', code, 'Then tell me.']);
  });

  it('attaches a card to its lead-in bubble', () => {
    const layout = layoutReply(`First.\n\nHere is the summary.\n\n${card()}`);
    expect(layout.cardErrors).toEqual([]);
    expect(layout.bubbles.map((b) => b.markdown)).toEqual(['First.', 'Here is the summary.']);
    expect(layout.bubbles[0]?.ui).toBeUndefined();
    expect(layout.bubbles[1]?.ui?.title).toBe('Options');
  });

  it('gives a card with no lead-in its own bubble with the card text form', () => {
    const layout = layoutReply(card());
    expect(layout.bubbles).toHaveLength(1);
    expect(layout.bubbles[0]?.markdown).toBe(uiDocToText(layout.bubbles[0]!.ui!));
  });

  it('starts a new bubble for text after a card', () => {
    const layout = layoutReply(`Summary.\n\n${card()}\n\nAnything else?`);
    expect(layout.bubbles.map((b) => b.markdown)).toEqual(['Summary.', 'Anything else?']);
    expect(layout.bubbles[0]?.ui).toBeDefined();
    expect(layout.bubbles[1]?.ui).toBeUndefined();
  });

  it('reports invalid JSON and an invalid doc, dropping the card', () => {
    const json = layoutReply(`Look.\n\n${card('{nope')}`);
    expect(json.bubbles).toEqual([{ markdown: 'Look.' }]);
    expect(json.cardErrors).toHaveLength(1);
    expect(json.cardErrors[0]).toMatch(/^card 1: not valid JSON/);
    const schema = layoutReply(`Look.\n\n${card('{"version":1,"blocks":[]}')}`);
    expect(schema.bubbles).toEqual([{ markdown: 'Look.' }]);
    expect(schema.cardErrors[0]).toMatch(/^card 1: /);
  });

  it('treats an unclosed card fence as an invalid card', () => {
    const layout = layoutReply('Look.\n\n```card\n{"version":1');
    expect(layout.bubbles).toEqual([{ markdown: 'Look.' }]);
    expect(layout.cardErrors).toEqual(['card 1: missing closing fence']);
  });

  it('falls back to one bubble per segment past the bubble cap', () => {
    const paragraphs = Array.from({ length: MAX_REPLY_BUBBLES + 2 }, (_, i) => `Line ${i}.`);
    expect(markdowns(paragraphs.join('\n\n'))).toEqual([paragraphs.join('\n\n')]);
    const withCard = layoutReply(`${paragraphs.join('\n\n')}\n\n${card()}`);
    expect(withCard.bubbles).toHaveLength(1);
    expect(withCard.bubbles[0]?.ui).toBeDefined();
  });
});
