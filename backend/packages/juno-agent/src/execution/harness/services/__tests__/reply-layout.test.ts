import { describe, expect, it } from 'vitest';
import { uiDocToText } from '@agent-desktop/public-contracts';
import { layoutReply } from '../reply-layout.js';

const CARD_JSON = JSON.stringify({ version: 1, title: 'Options', blocks: [{ type: 'facts', rows: [{ label: 'Price', value: '$10' }] }] });
const card = (body: string = CARD_JSON): string => '```card\n' + body + '\n```';

describe('layoutReply: a reply is one bubble', () => {
  it('keeps a single greeting as one bubble and nothing as none', () => {
    expect(layoutReply('Hey there!').bubble).toEqual({ markdown: 'Hey there!' });
    expect(layoutReply('  \n \n').bubble).toBeUndefined();
  });

  it('keeps blank lines, a trailing colon, lists, headings, tables and code inside the one bubble', () => {
    const text = [
      '好嘞，就去 KillineyGO，我帮你查下地址和开门时间。', '', '搞定，直接点这个就能导航过去了：', '', 'https://maps.example/x', '',
      '- a', '- b', '', '- c', '', '# Plan', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```js\nconst a = 1;\n\nconst b = 2;\n```', '', 'Done.',
    ].join('\n');
    expect(layoutReply(text).bubble).toEqual({ markdown: text });
  });

  it('trims the outside of the text and leaves the inside as written', () => {
    expect(layoutReply('\n\n  One.\n\n\nTwo.  \n\n').bubble?.markdown).toBe('One.\n\n\nTwo.');
  });

  it('a line of dashes is just text: nothing splits on it', () => {
    expect(layoutReply('One.\n---\nTwo.').bubble?.markdown).toBe('One.\n---\nTwo.');
  });
});

describe('layoutReply: cards', () => {
  it('attaches the card to the bubble with its text', () => {
    const layout = layoutReply(`Here is the summary.\n\n${card()}`);
    expect(layout.cardErrors).toEqual([]);
    expect(layout.bubble?.markdown).toBe('Here is the summary.');
    expect(layout.bubble?.ui?.title).toBe('Options');
  });

  it('keeps the text after a card in the same bubble', () => {
    const layout = layoutReply(`Summary.\n\n${card()}\n\nAnything else?`);
    expect(layout.bubble?.markdown).toBe('Summary.\n\nAnything else?');
    expect(layout.bubble?.ui).toBeDefined();
  });

  it('gives a card with no text the card text form', () => {
    const layout = layoutReply(card());
    expect(layout.bubble?.markdown).toBe(uiDocToText(layout.bubble!.ui!));
  });

  it('keeps a second card as its text form after the first', () => {
    const layout = layoutReply(`Two.\n\n${card()}\n\n${card()}`);
    expect(layout.bubble?.ui).toBeDefined();
    expect(layout.bubble?.markdown).toContain('Options');
  });

  it('reports invalid JSON, an invalid doc and an unclosed fence, dropping the card', () => {
    const json = layoutReply(`Look.\n\n${card('{nope')}`);
    expect(json.bubble).toEqual({ markdown: 'Look.' });
    expect(json.cardErrors[0]).toMatch(/^card 1: not valid JSON/);
    expect(layoutReply(`Look.\n\n${card('{"version":1,"blocks":[]}')}`).cardErrors[0]).toMatch(/^card 1: /);
    expect(layoutReply('Look.\n\n```card\n{"version":1').cardErrors).toEqual(['card 1: missing closing fence']);
  });
});
