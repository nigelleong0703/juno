/**
 * LOOP-COST1 wire pricing: explicit rates reach the pi-ai wire cost verbatim (the pinned
 * identity), missing pricing leaves zero wire cost yet still reports unknown usage, malformed
 * rates throw instead of wiring, and explicit free is known (never conflated with unknown).
 */
import { describe, expect, it } from 'vitest';
import type { Usage } from '@earendil-works/pi-ai';
import { wireModelFor } from '../provider-wire-compat.js';
import { toAssistantUsage } from '../provider-usage.js';

const PRICING = { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 };
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST = { modelId: 'qa-model', baseUrl: 'http://127.0.0.1:12345/v1', supportsImages: false, limits: {} };

function usageWith(counters: { input: number; output: number; cacheRead: number; cacheWrite: number }, total: number): Usage {
  return { ...counters, totalTokens: counters.input + counters.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}

function usage(input: number, output: number, total: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

describe('provider pricing wire', () => {
  it('carries explicit pricing onto the wire cost verbatim', () => {
    expect(wireModelFor({ ...REQUEST, pricing: PRICING }).cost).toEqual(PRICING);
  });

  it('leaves zero wire cost when pricing is missing', () => {
    expect(wireModelFor(REQUEST).cost).toEqual(FREE);
  });

  it('rejects malformed pricing instead of wiring it', () => {
    expect(() => wireModelFor({ ...REQUEST, pricing: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } })).toThrow(/pricing/i);
    expect(() => wireModelFor({ ...REQUEST, pricing: { input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0 } })).toThrow();
  });

  it('marks measured usage known only with defined rates; explicit free is known', () => {
    const priced = toAssistantUsage(usage(10, 5, 0.00002), PRICING);
    expect(priced.measured).toBe(true);
    expect(priced.costKnown).toBe(true);
    expect(priced.costUsd).toBe(0.00002);
    const free = toAssistantUsage(usage(10, 5, 0), FREE);
    expect(free.measured).toBe(true);
    expect(free.costKnown).toBe(true);
    expect(free.costUsd).toBe(0);
    const missing = toAssistantUsage(usage(10, 5, 0.00002), undefined);
    expect(missing.measured).toBe(true);
    expect(missing.costKnown).toBe(false);
    expect(missing.costUsd).toBe(0);
  });

  it('rejects malformed counters: nothing measured, nothing charged, nothing known', () => {
    const bad = [
      { input: -1, output: 5, cacheRead: 0, cacheWrite: 0 },
      { input: Number.POSITIVE_INFINITY, output: 5, cacheRead: 0, cacheWrite: 0 },
      { input: Number.NaN, output: 5, cacheRead: 0, cacheWrite: 0 },
      { input: 1.5, output: 5, cacheRead: 0, cacheWrite: 0 },
      { input: 10, output: -2, cacheRead: 0, cacheWrite: 0 },
      { input: 10, output: 5, cacheRead: Number.NaN, cacheWrite: 0 },
      { input: 10, output: 5, cacheRead: 0, cacheWrite: Number.POSITIVE_INFINITY },
    ];
    for (const counters of bad) {
      for (const rates of [PRICING, FREE, undefined]) {
        const mapped = toAssistantUsage(usageWith(counters, 0.00002), rates);
        expect(mapped.measured).toBe(false);
        expect(mapped.costKnown).toBe(false);
        expect(mapped.costUsd).toBe(0);
        expect(mapped.inputTokens).toBe(0);
        expect(mapped.outputTokens).toBe(0);
        expect(mapped.cacheReadTokens).toBe(0);
        expect(mapped.cacheWriteTokens).toBe(0);
      }
    }
  });

  it('never charges or claims malformed cost totals', () => {
    for (const total of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5]) {
      const mapped = toAssistantUsage(usage(10, 5, total), PRICING);
      expect(mapped.measured).toBe(true);
      expect(mapped.inputTokens).toBe(10);
      expect(mapped.costKnown).toBe(false);
      expect(mapped.costUsd).toBe(0);
    }
  });
  it('treats absent or all-zero usage as unmeasured even with pricing', () => {
    const absent = toAssistantUsage(undefined, PRICING);
    expect(absent.measured).toBe(false);
    expect(absent.costKnown).toBe(false);
    const zero = toAssistantUsage(usage(0, 0, 0), PRICING);
    expect(zero.measured).toBe(false);
    expect(zero.inputTokens).toBe(0);
    expect(zero.costKnown).toBe(false);
  });
});
