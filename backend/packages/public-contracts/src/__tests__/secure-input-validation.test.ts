import { describe, expect, it } from 'vitest';
import { validateSecureInputValues, type SecureInputField } from '../models/request.js';

describe('validateSecureInputValues', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  const f = (over: Partial<SecureInputField> & Pick<SecureInputField, 'kind'>): SecureInputField => ({ id: 'f', label: 'L', ...over });
  const err = (field: SecureInputField, value?: string) => {
    const r = validateSecureInputValues([field], value === undefined ? {} : { f: value }, now);
    return 'errors' in r ? r.errors['f'] : undefined;
  };

  it('checks card number length and Luhn, expiry and cvc', () => {
    expect(err(f({ kind: 'card_number' }), '4242 4242 4242 4242')).toBeUndefined();
    expect(err(f({ kind: 'card_number' }), '4242 4242 4242 4241')).toBeDefined();
    expect(err(f({ kind: 'card_number' }), '1234')).toBeDefined();
    expect(err(f({ kind: 'card_expiry' }), '12/29')).toBeUndefined();
    expect(err(f({ kind: 'card_expiry' }), '13/29')).toBeDefined();
    expect(err(f({ kind: 'card_cvc' }), '12')).toBeDefined();
  });

  it('checks month 1-12 and a 4 digit year not in the past', () => {
    const month = f({ kind: 'month', min: 1, max: 12 });
    expect(err(month, '12')).toBeUndefined();
    expect(err(month, '13')).toBeDefined();
    expect(err(month, '0')).toBeDefined();
    expect(err(f({ kind: 'year' }), '2026')).toBeUndefined();
    expect(err(f({ kind: 'year' }), '2025')).toBe('The year is in the past');
    expect(err(f({ kind: 'year' }), '26')).toBeDefined();
  });

  it('checks email, options, maxLength and required, without echoing the value', () => {
    expect(err(f({ kind: 'email' }), 'nope')).toBeDefined();
    expect(err(f({ kind: 'country', options: ['SG', 'US'] }), 'XX')).toBe('Choose one of the offered options');
    expect(err(f({ kind: 'text', maxLength: 3 }), 'abcd')).toBeDefined();
    expect(err(f({ kind: 'name' }))).toBe('Required');
    expect(err(f({ kind: 'name', required: false }))).toBeUndefined();
    expect(JSON.stringify(validateSecureInputValues([f({ kind: 'card_number' })], { f: '4242424242424241' }, now))).not.toContain('4242');
  });
});
