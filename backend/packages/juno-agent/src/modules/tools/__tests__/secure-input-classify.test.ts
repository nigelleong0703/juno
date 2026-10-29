import { describe, expect, it } from 'vitest';
import { classifyFieldClasses, classifySecureField, fieldClass } from '../tools/secureInputClassify.js';

const input = (over: Record<string, unknown> = {}) => ({ ref: 'e1', tag: 'input', type: 'text', ...over }) as never;

describe('classifySecureField', () => {
  it('reads kinds from autocomplete and input type before any label', () => {
    expect(classifySecureField(input({ autocomplete: 'section-a cc-exp-month' }), 'Foo', undefined).kind).toBe('month');
    expect(classifySecureField(input({ autocomplete: 'postal-code' }), 'Foo', 'text').kind).toBe('postal_code');
    expect(classifySecureField(input({ type: 'email' }), 'Foo', 'text').kind).toBe('email');
    expect(classifySecureField(input({ type: 'tel' }), 'Foo', undefined).kind).toBe('phone');
    expect(classifySecureField(input({ type: 'number', min: 1, max: 5 }), 'Guests', undefined)).toMatchObject({ kind: 'number', min: 1, max: 5 });
  });

  it('types the Demoblaze checkout form from ids and labels (no useful attributes)', () => {
    const kinds = [
      ['姓名', 'name'], ['国家', 'country'], ['城市', 'city'], ['演示用卡号', 'card'], ['月份', 'month'], ['年份', 'year'],
    ].map(([label, id]) => classifySecureField(input({ id }), label as string, 'text'));
    expect(kinds.map((k) => k.kind)).toEqual(['name', 'country', 'city', 'card_number', 'month', 'year']);
    expect(kinds[4]).toMatchObject({ min: 1, max: 12 });
    expect(kinds[5]).toMatchObject({ maxLength: 4 });
  });

  it('takes limits, options and required from the page, defaulting to required', () => {
    expect(classifySecureField(input({ maxLength: 16, required: false, options: ['SG', 'US'] }), 'Country', undefined))
      .toMatchObject({ kind: 'country', maxLength: 16, required: false, options: ['SG', 'US'] });
    expect(classifySecureField(input(), 'Name', undefined).required).toBeUndefined();
  });

  it('falls back to the model kind, then text, when the page says nothing', () => {
    expect(classifySecureField(undefined, 'Value', 'otp').kind).toBe('otp');
    expect(classifySecureField(undefined, 'Value', undefined).kind).toBe('text');
  });
});

describe('field class: secret or profile', () => {
  it.each([
    // autocomplete tokens and input types decide first, even against a misleading label
    [{ autocomplete: 'section-pay cc-number' }, 'Name', 'secret'],
    [{ autocomplete: 'current-password' }, 'Email', 'secret'],
    [{ autocomplete: 'one-time-code' }, 'Code', 'secret'],
    [{ type: 'password' }, 'Email', 'secret'],
    [{ autocomplete: 'given-name' }, 'Card', 'profile'],
    [{ autocomplete: 'shipping address-line1' }, 'Foo', 'profile'],
    [{ autocomplete: 'address-level2' }, 'Foo', 'profile'],
    [{ autocomplete: 'tel-national' }, 'Foo', 'profile'],
    [{ type: 'email' }, 'Foo', 'profile'],
    [{ type: 'tel' }, 'Foo', 'profile'],
    // labels second
    [{}, 'Card number', 'secret'],
    [{}, 'Name on card', 'secret'],
    [{}, 'Expiry date', 'secret'],
    [{}, 'CVC', 'secret'],
    [{}, 'NRIC / passport number', 'secret'],
    [{}, 'Verification code', 'secret'],
    [{}, 'Postal code', 'profile'],
    [{}, 'Unit number', 'profile'],
    [{}, 'Phone', 'profile'],
    [{}, 'Full name', 'profile'],
    [{ placeholder: 'Mobile' }, 'Contact', 'profile'],
    // unclear
    [{}, 'Username', 'unknown'],
    [{}, 'Promo code', 'unknown'],
  ] as const)('%j / %s -> %s', (attrs, label, expected) => {
    expect(fieldClass(input(attrs), label)).toBe(expected);
  });

  const signal = new AbortController().signal;
  const says = (probabilities: Record<string, number> | null) => ({
    ask: async (_s: string, questions: Record<string, unknown>) =>
      probabilities === null ? null : Object.fromEntries(Object.keys(questions).map((name) => {
        const [choice = 'unknown', top = 0] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? [];
        return [name, { type: 'choice' as const, choice, probabilities, confidence: top }];
      })),
  });
  const unclear = [{ attrs: input(), label: 'Promo code' }];

  it('asks System One only about unclear fields; a confident profile verdict is taken', async () => {
    expect(await classifyFieldClasses([...unclear, { attrs: input(), label: 'Phone' }], says({ profile: 0.95, secret: 0.03, unknown: 0.02 }), signal)).toEqual(['profile', 'profile']);
  });

  it('treats an unsure, secret, unknown, failed or missing System One as a secret', async () => {
    expect(await classifyFieldClasses(unclear, says({ profile: 0.6, secret: 0.3, unknown: 0.1 }), signal)).toEqual(['secret']);
    expect(await classifyFieldClasses(unclear, says({ profile: 0.1, secret: 0.8, unknown: 0.1 }), signal)).toEqual(['secret']);
    expect(await classifyFieldClasses(unclear, says(null), signal)).toEqual(['secret']);
    expect(await classifyFieldClasses(unclear, { ask: async () => { throw new Error('down'); } }, signal)).toEqual(['secret']);
    expect(await classifyFieldClasses(unclear, undefined, signal)).toEqual(['secret']);
  });
});
