import { describe, expect, it } from 'vitest';
import { parseUiDoc, uiDocToText, uiDocSchema, validateUiAnswers, type UiDoc } from '../models/ui.js';

const choices = { type: 'choices', id: 'go', options: [{ id: 'yes', label: 'Continue' }, { id: 'no', label: 'Cancel', style: 'destructive' }] } as const;
const text = (t: string) => ({ type: 'text', text: t }) as const;
const doc = (...blocks: unknown[]) => ({ version: 1, blocks });
const accepts = (d: unknown, context: 'message' | 'question' = 'message') => parseUiDoc(d, context).ok;
const error = (d: unknown, context: 'message' | 'question' = 'message') => {
  const r = parseUiDoc(d, context);
  return r.ok ? undefined : r.error;
};

describe('uiDocSchema', () => {
  it('accepts every block kind within limits', () => {
    expect(accepts(doc(
      text('Short.'),
      { type: 'facts', rows: [{ label: 'Delivery', value: 'Fri 18 Oct', emphasis: true }] },
      { type: 'items', rows: [{ name: 'Mac mini', quantity: 1, price: 'S$799', imageUrl: 'https://x.dev/a.png' }], total: { label: 'Total', value: 'S$799' } },
      { type: 'table', columns: ['A', 'B'], rows: [['1', '2']] },
      { type: 'notice', tone: 'warning', text: 'Goes on to payment.' },
      { type: 'link', url: 'https://x.dev', title: 'Page' },
      { type: 'image', libraryId: 'lib_1' },
    ))).toBe(true);
    expect(accepts(doc(text('Pick'), { type: 'fields', id: 'f', fields: [{ id: 'size', label: 'Size', kind: 'select', options: ['S', 'M'] }] }), 'question')).toBe(true);
  });

  it.each([
    ['no blocks', doc(), /blocks/],
    ['13 blocks', doc(...Array.from({ length: 13 }, () => text('x'))), /blocks/],
    ['text over 400', doc(text('x'.repeat(401))), /text/],
    ['markdown table in text', doc(text('| a | b |\n|---|---|')), /markdown/],
    ['markdown header in text', doc(text('# Heading')), /markdown/],
    ['multi-line title', { ...doc(text('x')), title: 'a\nb' }, /single line/],
    ['title over 80', { ...doc(text('x')), title: 'x'.repeat(81) }, /title/],
    ['http link', doc({ type: 'link', url: 'http://x.dev', title: 'P' }), /https/],
    ['table row width mismatch', doc({ type: 'table', columns: ['A', 'B'], rows: [['1']] }), /columns/],
    ['one column table', doc({ type: 'table', columns: ['A'], rows: [['1']] }), /columns/],
    ['one option', doc({ type: 'choices', id: 'c', options: [{ id: 'a', label: 'A' }] }), /options/],
    ['select without options', doc({ type: 'fields', id: 'f', fields: [{ id: 'a', label: 'A', kind: 'select' }] }), /needs options/],
    ['duplicate ids', doc({ type: 'choices', id: 'c', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), /unique/],
    ['two interactive blocks', doc(choices, { type: 'fields', id: 'f', fields: [{ id: 'a', label: 'A', kind: 'text' }] }), /one interactive/],
    ['nested group', doc({ type: 'group', blocks: [{ type: 'group', blocks: [text('x')] }] }), /display blocks only/],
    ['choices in a group', doc({ type: 'group', blocks: [choices] }), /display blocks only/],
    ['13 blocks counting group children', doc(...Array.from({ length: 5 }, () => ({ type: 'group', blocks: [text('a'), text('b')] }))), /in all/],
    ['over 8 KB', doc(...Array.from({ length: 12 }, () => ({ type: 'table', columns: ['a', 'b'], rows: Array.from({ length: 20 }, () => ['x'.repeat(40), 'y'.repeat(40)]) }))), /KB/],
  ])('rejects %s with a useful message', (_name, input, message) => {
    expect(error(input)).toMatch(message);
  });

  it('requires one interactive block in a question and none in a message', () => {
    expect(error(doc(text('Proceed?')), 'question')).toMatch(/exactly one interactive/);
    expect(accepts(doc(text('Proceed?'), choices), 'question')).toBe(true);
    expect(error(doc(text('Proceed?'), choices), 'message')).toMatch(/only work in kind "question"/);
  });
});

describe('uiDocToText', () => {
  it('renders title, facts, items with total and a notice', () => {
    const d = uiDocSchema.parse({
      version: 1,
      title: 'Place this order at Apple?',
      blocks: [
        { type: 'items', rows: [{ name: 'Mac mini', detail: 'M4, 16GB', quantity: 2, price: 'S$799' }], total: { label: 'Total', value: 'S$1,598' } },
        { type: 'facts', rows: [{ label: 'Delivery', value: 'Fri 18 Oct' }] },
        { type: 'notice', tone: 'warning', text: 'You are charged now.' },
      ],
    });
    expect(uiDocToText(d)).toBe('Place this order at Apple?\n\n• Mac mini — M4, 16GB ×2 S$799\nTotal: S$1,598\nDelivery: Fri 18 Oct\nWarning: You are charged now.');
  });

  it('aligns table columns and lists choices', () => {
    const d: UiDoc = uiDocSchema.parse(doc(
      { type: 'table', columns: ['Config', 'Price'], rows: [['M4 16GB', 'S$799'], ['M4 Pro', 'S$1,899']] },
      choices,
    ));
    expect(uiDocToText(d)).toBe('Config   Price\nM4 16GB  S$799\nM4 Pro   S$1,899\nOptions: Continue / Cancel');
  });

  it('renders link, image and fields', () => {
    const d = uiDocSchema.parse(doc(
      { type: 'link', url: 'https://apple.com/sg', title: 'Apple', subtitle: 'Mac mini' },
      { type: 'image', libraryId: 'lib_1', caption: 'Cart' },
      { type: 'fields', id: 'f', fields: [{ id: 'q', label: 'Quantity', kind: 'number' }, { id: 'n', label: 'Note', kind: 'text', required: false }] },
    ));
    expect(uiDocToText(d)).toBe('Apple (Mac mini): https://apple.com/sg\n[Image: Cart]\nFields: Quantity, Note (optional)');
  });
});

describe('group and fallback text', () => {
  it('renders the group title then its blocks indented, and stores the text fallback on the doc', () => {
    const r = parseUiDoc(doc({ type: 'group', title: 'M4 16GB', blocks: [{ type: 'facts', rows: [{ label: 'Price', value: 'S$799' }] }, text('Quiet.')] }, choices), 'question');
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.text).toBe('M4 16GB\n  Price: S$799\n  Quiet.\nOptions: Continue / Cancel');
    expect(parseUiDoc({ ...doc(text('Hi')), text: 'model wrote this' }, 'message')).toMatchObject({ doc: { text: 'Hi' } });
  });
});

describe('validateUiAnswers', () => {
  const pick = uiDocSchema.parse(doc(choices));
  const multi = uiDocSchema.parse(doc({ ...choices, multiple: true }));
  const form = uiDocSchema.parse(doc({ type: 'fields', id: 'f', fields: [
    { id: 'qty', label: 'Qty', kind: 'number' }, { id: 'day', label: 'Day', kind: 'date', required: false }, { id: 'size', label: 'Size', kind: 'select', options: ['S', 'M'] },
  ] }));

  it('maps a choice to its option id, keyed by the block id', () => {
    expect(validateUiAnswers(pick, { go: 'yes' })).toEqual({ ok: true });
    expect(validateUiAnswers(pick, { go: 'maybe' })).toHaveProperty('errors.go');
    expect(validateUiAnswers(pick, {})).toEqual({ errors: { go: 'Required' } });
    expect(validateUiAnswers(multi, { go: '["yes","no"]' })).toEqual({ ok: true });
    expect(validateUiAnswers(multi, { go: 'yes' })).toHaveProperty('errors.go');
  });

  it('maps fields by field id and reports each bad one', () => {
    expect(validateUiAnswers(form, { qty: '2', size: 'M' })).toEqual({ ok: true });
    expect(validateUiAnswers(form, { qty: 'x', day: '2026-02-30', size: 'XL', extra: '1' })).toEqual({
      errors: { qty: 'Enter a number', day: 'Enter a date as YYYY-MM-DD', size: 'Must be one of: S, M', extra: 'Unknown answer id' },
    });
  });
});
