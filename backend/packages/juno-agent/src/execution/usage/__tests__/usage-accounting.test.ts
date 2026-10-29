import { describe, expect, it } from "vitest"
import {
  addActiveMs,
  checkBudget,
  createUsageState,
  observeUsage,
  parseBudgetLimits,
  totalTokens,
  type UsageSample,
  type UsageState,
} from "../index.js"

const state = (limits = {}): UsageState => createUsageState(limits)

// Untrusted runtime input crosses a parse boundary here; any decodes without assertion.
const injected = (json: string): UsageSample => JSON.parse(json)

describe("malformed observations cannot corrupt totals", () => {
  it("clamps negative and non-finite counters and marks unknown", () => {
    const after = observeUsage(
      state(),
      { inputTokens: -100, outputTokens: NaN, cacheReadTokens: Infinity, cacheWriteTokens: 1.5, costUsd: -10, costKnown: true, measured: true },
      "bad",
    )
    expect(after.totals.inputTokens).toBe(0)
    expect(after.totals.outputTokens).toBe(0)
    expect(after.totals.cacheReadTokens).toBe(0)
    expect(after.totals.cacheWriteTokens).toBe(0)
    expect(after.totals.costUsd).toBe(0)
    expect(after.unknownTokens).toBe(true)
    expect(after.unknownCost).toBe(true)
    expect(Number.isFinite(totalTokens(after.totals))).toBe(true)
  })

  it("never lets invalid usage reduce a known lower bound", () => {
    const known = observeUsage(state(), { inputTokens: 2, outputTokens: 1, costUsd: 0.2, costKnown: true, measured: true }, "valid")
    const after = observeUsage(known, { inputTokens: -100, outputTokens: NaN, costUsd: -10, costKnown: true, measured: true }, "invalid")
    expect(after.totals.inputTokens).toBe(2)
    expect(after.totals.outputTokens).toBe(1)
    expect(after.totals.costUsd).toBe(0.2)
    expect(after.unknownTokens).toBe(true)
    expect(after.unknownCost).toBe(true)
  })

  it("treats required claims that are missing or null as unknown, never as measured free", () => {
    const missing = observeUsage(state(), injected('{"outputTokens":1,"costUsd":0.1,"costKnown":true,"measured":true}'), "missing")
    expect(missing.totals.inputTokens).toBe(0)
    expect(missing.unknownTokens).toBe(true)
    const nulled = observeUsage(state(), injected('{"inputTokens":1,"outputTokens":1,"costUsd":null,"costKnown":true,"measured":true}'), "null")
    expect(nulled.totals.costUsd).toBe(0)
    expect(nulled.unknownCost).toBe(true)
    expect(nulled.unknownTokens).toBe(false)
  })

  it("rejects fractional and unsafe-integer token counts while keeping decimal money", () => {
    const after = observeUsage(
      state(),
      { inputTokens: 1.5, outputTokens: 2 ** 53, costUsd: 0.0001, costKnown: true, measured: true },
      "shapes",
    )
    expect(after.totals.inputTokens).toBe(0)
    expect(after.totals.outputTokens).toBe(0)
    expect(after.totals.costUsd).toBe(0.0001)
    expect(after.unknownTokens).toBe(true)
    expect(after.unknownCost).toBe(false)
  })

  it("saturates overflowing totals instead of polluting persisted JSON", () => {
    const full = observeUsage(state(), { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, costUsd: 0, costKnown: true, measured: true }, "full")
    const over = observeUsage(full, { inputTokens: 1, outputTokens: 0, costUsd: 0, costKnown: true, measured: true }, "over")
    expect(over.totals.inputTokens).toBe(Number.MAX_SAFE_INTEGER)
    expect(Number.isFinite(over.totals.inputTokens)).toBe(true)
    expect(JSON.stringify(over.totals)).not.toContain("null")
    expect(over.unknownTokens).toBe(true)
  })

  it("counts a replayed key exactly once", () => {
    const once = observeUsage(state(), { inputTokens: 3, outputTokens: 1, costUsd: 0.1, costKnown: true, measured: true }, "k")
    const twice = observeUsage(once, { inputTokens: 300, outputTokens: 100, costUsd: 9, costKnown: true, measured: true }, "k")
    expect(twice.totals).toEqual(once.totals)
  })
})

describe("honest partial lower bounds", () => {
  it("keeps valid counters from an unmeasured observation and still marks unknown", () => {
    const after = observeUsage(state(), { inputTokens: 5, outputTokens: 2, costUsd: 0.3, costKnown: false, measured: false }, "partial")
    expect(after.totals.inputTokens).toBe(5)
    expect(after.totals.outputTokens).toBe(2)
    expect(after.totals.costUsd).toBe(0.3)
    expect(after.unknownTokens).toBe(true)
    expect(after.unknownCost).toBe(true)
  })

  it("enforces the known lower bound even while unknown", () => {
    const after = observeUsage(
      state({ tokens: 5, onUnknown: "ignore" }),
      { inputTokens: 5, outputTokens: 2, costUsd: 0, costKnown: false, measured: false },
      "partial",
    )
    expect(checkBudget(after).ok).toBe(false)
  })

  it("blocks on unknown spend only under the frozen block policy", () => {
    const sample: UsageSample = { inputTokens: 1, outputTokens: 0, costUsd: 0, costKnown: false, measured: false }
    expect(checkBudget(observeUsage(state({ tokens: 100, onUnknown: "block" }), sample, "a")).ok).toBe(false)
    expect(checkBudget(observeUsage(state({ tokens: 100, onUnknown: "ignore" }), sample, "a")).ok).toBe(true)
  })
})

describe("active time hygiene", () => {
  it("drops NaN, negative and infinite durations", () => {
    expect(addActiveMs(state(), NaN).totals.activeMs).toBe(0)
    expect(addActiveMs(state(), -50).totals.activeMs).toBe(0)
    expect(addActiveMs(state(), Infinity).totals.activeMs).toBe(0)
    expect(addActiveMs(state(), 200).totals.activeMs).toBe(200)
  })

  it("marks unmeasurable durations as unknown-active instead of free", () => {
    expect(addActiveMs(state(), NaN).unknownActive).toBe(true)
    expect(addActiveMs(state(), -50).unknownActive).toBe(true)
    expect(addActiveMs(state(), 200).unknownActive).toBe(false)
    const observed = observeUsage(state(), { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, measured: true, activeKnown: false }, "k")
    expect(observed.unknownActive).toBe(true)
  })

  it("blocks unmeasurable active time only under the frozen block policy", () => {
    const sample: UsageSample = { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, measured: true, activeKnown: false }
    const blocked = observeUsage(state({ activeSeconds: 100, tokens: 100, onUnknown: "block" }), sample, "a")
    expect(checkBudget(blocked).ok).toBe(false)
    const allowed = observeUsage(state({ activeSeconds: 100 }), sample, "a")
    expect(checkBudget(allowed).ok).toBe(true)
  })

  it("dedups keyed active time across replays", () => {
    const once = addActiveMs(state(), 200, "tool:0")
    expect(addActiveMs(once, 200, "tool:0").totals.activeMs).toBe(200)
  })

  it("parses explicit budgets with block-by-default and tolerates malformed settings", () => {
    expect(parseBudgetLimits({ usage: { tokens: 10 } })).toMatchObject({ tokens: 10, onUnknown: "block" })
    expect(parseBudgetLimits({ usage: { tokens: 10, onUnknown: "ignore" } })).toMatchObject({ onUnknown: "ignore" })
    expect(parseBudgetLimits({ usage: { tokens: -5, costUsd: NaN } })).toEqual({})
    expect(parseBudgetLimits(null)).toEqual({})
  })
})
