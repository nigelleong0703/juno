import { describe, expect, it } from 'vitest';
import {
  isFreePricing,
  normalizeBaseUrl,
  parsePricingTable,
  pricingFor,
} from '../model-pricing.js';

const BASE = 'http://provider.test/v1';

function table() {
  return parsePricingTable([
    { baseUrl: BASE, modelId: 'priced', input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 },
    { baseUrl: BASE, modelId: 'free', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
}

describe('explicit per-endpoint model pricing', () => {
  it('looks up the exact endpoint and model only', () => {
    const found = pricingFor(table(), BASE, 'priced');
    expect(found).toEqual({ input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 });
    expect(pricingFor(table(), BASE, 'other')).toBeUndefined();
    expect(pricingFor(table(), 'http://other.test/v1', 'priced')).toBeUndefined();
    expect(pricingFor(table(), BASE, 'PRICED')).toBeUndefined();
  });

  it('ignores branded manifest rates: unknown without an explicit entry', () => {
    expect(pricingFor(table(), BASE, 'gpt-6-astra')).toBeUndefined();
    expect(pricingFor([], BASE, 'priced')).toBeUndefined();
  });

  it('distinguishes explicit free from missing', () => {
    const priced = table();
    const free = pricingFor(priced, BASE, 'free');
    expect(free).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(free === undefined ? false : isFreePricing(free)).toBe(true);
    expect(pricingFor(priced, BASE, 'missing')).toBeUndefined();
  });

  it('normalizes only trailing slashes on the endpoint', () => {
    expect(pricingFor(table(), BASE + '///', 'priced')).toEqual(pricingFor(table(), BASE, 'priced'));
    expect(normalizeBaseUrl(BASE + '/')).toBe(BASE);
  });

  it('accepts wrapped and JSON-text forms, empty stays unknown', () => {
    expect(parsePricingTable([])).toEqual([]);
    expect(parsePricingTable('')).toEqual([]);
    expect(parsePricingTable({ entries: [] })).toEqual([]);
    const wrapped = parsePricingTable({ entries: [{ baseUrl: BASE, modelId: 'm', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] });
    expect(pricingFor(wrapped, BASE, 'm')).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    const text = parsePricingTable(JSON.stringify([{ baseUrl: BASE, modelId: 'm', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }]));
    expect(pricingFor(text, BASE, "m")).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it('rejects malformed pricing loudly instead of treating it as unknown', () => {
    expect(() => parsePricingTable('not json{')).toThrow(/valid JSON/);
    expect(() => parsePricingTable([{ baseUrl: BASE, modelId: 'm', input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }])).toThrow();
    expect(() => parsePricingTable([{ baseUrl: BASE, modelId: 'm', input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0 }])).toThrow();
    expect(() => parsePricingTable([{ baseUrl: BASE, modelId: 'm', input: Number.POSITIVE_INFINITY, output: 0, cacheRead: 0, cacheWrite: 0 }])).toThrow();
    expect(() => parsePricingTable({ entries: [{ baseUrl: BASE, modelId: 'm', input: 1, output: 2 }] })).toThrow();
    expect(() => parsePricingTable([
      { baseUrl: BASE, modelId: 'dup', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { baseUrl: BASE + '/', modelId: 'dup', input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
    ])).toThrow(/Duplicate/);
  });
});
