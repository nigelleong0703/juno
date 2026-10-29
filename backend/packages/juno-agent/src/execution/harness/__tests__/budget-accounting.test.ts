import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from "vitest"
import { RestatePromise } from "@agent-desktop/durable"
import { createMemoryStore, NoopEnqueuer } from "../../../testing/store.js"
import type { AssistantTurn, Brain, BrainContext, Store, WakeEvent } from "../../../contracts/index.js"
import type { Run } from "@agent-desktop/public-contracts"
import { requestScopedStore } from "../../../owner-context.js"
import { createWaitForTool } from "../../../modules/tools/tools/waitFor.js"
import { ModelTurnError } from "../../brain/model-turn-error.js"
import { NEVER_CANCELLED } from "../services/cancel.js"
import { runLoop } from "../services/run-loop.js"
import { createRunBudget } from "../services/run-budget.js"
import { childSnapshotFor, snapshotOf } from "../services/budget-snapshot.js"
import type { AppSettings } from "@agent-desktop/public-contracts"
import { chargeCompactionStep, chargeEffect, chargeFailedAttemptStep, checkBeforeEffect } from "../services/model-budget.js"
import type { RunContext, RunInput, RunServices } from "../services/run-types.js"
const AT = "2026-10-08T00:00:00.000Z"
const OWNER = "owner-budget-acct"
const AGENT = "agent-budget-acct"
const CONV = "conv-budget-acct"
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 }

const wake: WakeEvent = {
  id: "wake-1", ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ":" + CONV, conversationId: CONV,
  kind: "user_message", origin: { type: "user" }, trusted: true, priority: "user",
  payload: { text: "go" }, at: AT, status: "accepted",
}
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ":" + CONV, wakeEvents: [wake] }

function runDoc(): Run {
  return {
    id: "run-1", agentId: AGENT, conversationId: CONV, title: "budget", status: "running", kind: "chat", steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }
}

function testContext(clock: { now: number }): RunContext & { sleeps: number[] } {
  const used = new Set<string>()
  let seq = 0
  const sleeps: number[] = []
  const ctx: RunContext = {
    rand: { uuidv4: () => "id-" + String(seq++) },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
      if (used.has(name)) throw new Error("duplicate durable step: " + name)
      used.add(name)
      return RestatePromise.resolve(action())
    },
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => {
      throw new Error("no human waits in budget tests")
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    date: { now: () => RestatePromise.resolve(clock.now) },
    sleep: (ms: number) => {
      sleeps.push(ms)
      clock.now += ms
      return RestatePromise.resolve(undefined)
    },
  }
  return { ...ctx, sleeps }
}

const dummyServices = (store: Store): RunServices => ({
  store, blobs: createMemoryBlobStore(),
  enqueuer: new NoopEnqueuer(),
  brain: {
    buildContext: async () => ({ sessionKey: input.sessionKey, agentId: AGENT }),
    step: async () => { throw new Error("unused") },
    shouldCompact: () => false,
    compact: async (ctx) => ctx,
  },
  toolRegistry: { forAgent: async () => [], get: () => undefined },
})
describe("budget service accounting", () => {
  it("keeps finite lower bounds and blocks on malformed usage", () => {
    const budget = createRunBudget({ costUsd: 1, tokens: 10, activeSeconds: 1, onUnknown: "block" }, true)
    budget.charge("valid", { inputTokens: 2, outputTokens: 1, costUsd: 0.2, costKnown: true, measured: true }, 200)
    budget.charge("invalid", { inputTokens: -100, outputTokens: NaN, costUsd: -10, costKnown: true, measured: true }, NaN)
    const totals = budget.totals()
    expect(Number.isFinite(totals.inputTokens) && totals.inputTokens >= 2).toBe(true)
    expect(Number.isFinite(totals.outputTokens) && totals.outputTokens >= 1).toBe(true)
    expect(Number.isFinite(totals.costUsd) && totals.costUsd >= 0.2).toBe(true)
    expect(Number.isFinite(totals.activeMs) && totals.activeMs >= 200).toBe(true)
    expect(budget.check().ok).toBe(false)
  })

  it("charges failed attempts as unknown work without inventing tokens", async () => {
    const raw = createMemoryStore()
    await raw.put("runs", runDoc())
    const store = requestScopedStore(raw)
    const budget = createRunBudget({}, false)
    const within = await chargeFailedAttemptStep({ ctx: testContext({ now: Date.now() }), services: dummyServices(store), runId: "run-1", budget, key: "model:0:retry:1", durationMs: 120 })
    expect(within.ok).toBe(true)
    expect(budget.totals().activeMs).toBe(120)
    expect(budget.unknowns()).toMatchObject({ cost: true, tokens: true, actions: 1 })
    expect(budget.totals().inputTokens).toBe(0)
  })

  it("sanitizes NaN attempt durations instead of poisoning active time", async () => {
    const raw = createMemoryStore()
    await raw.put("runs", runDoc())
    const store = requestScopedStore(raw)
    const budget = createRunBudget({}, false)
    await chargeFailedAttemptStep({ ctx: testContext({ now: Date.now() }), services: dummyServices(store), runId: "run-1", budget, key: "k", durationMs: NaN })
    expect(budget.totals().activeMs).toBe(0)
    expect(Number.isFinite(budget.totals().activeMs)).toBe(true)
    expect(budget.unknowns().active).toBe(true)
  })

  it("charges reported compaction metrics and clamps malformed ones", async () => {
    const raw = createMemoryStore()
    await raw.put("runs", runDoc())
    const store = requestScopedStore(raw)
    const budget = createRunBudget({}, false)
    const ctx = testContext({ now: Date.now() })
    await chargeCompactionStep({ ctx, services: dummyServices(store), runId: "run-1", budget, key: "compact:0", context: { compactionMetrics: { durationMs: 40, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, costKnown: false, measured: true } } } })
    expect(budget.totals().activeMs).toBe(40)
    expect(budget.totals().inputTokens).toBe(10)
    expect(budget.totals().costUsd).toBe(0.01)
    expect(budget.unknowns().cost).toBe(true)
    await chargeCompactionStep({ ctx, services: dummyServices(store), runId: "run-1", budget, key: "compact:1", context: { compactionMetrics: { durationMs: NaN, usage: { inputTokens: -5, costUsd: NaN } } } })
    expect(budget.totals().inputTokens).toBe(10)
    expect(Number.isFinite(budget.totals().costUsd)).toBe(true)
    expect(budget.unknowns().tokens).toBe(true)
    expect(budget.unknowns().active).toBe(true)
  })

  it("charges completion effects and blocks truthfully when exhausted", async () => {
    const raw = createMemoryStore()
    await raw.put("runs", runDoc())
    const store = requestScopedStore(raw)
    const budget = createRunBudget({ steps: 10 }, false)
    const scope = { ctx: testContext({ now: Date.now() }), services: dummyServices(store), runId: "run-1", budget }
    expect((await checkBeforeEffect(scope, "complete:0")).ok).toBe(true)
    expect((await chargeEffect(scope, "complete:0", 50)).ok).toBe(true)
    expect(budget.totals().activeMs).toBe(50)
    const tight = createRunBudget({ steps: 1 }, false)
    const tightScope = { ctx: testContext({ now: Date.now() }), services: dummyServices(store), runId: "run-1", budget: tight }
    expect((await chargeEffect(tightScope, "complete:0", 10)).ok).toBe(false)
    expect((await raw.get("runs", "run-1"))?.error).toContain("step budget")
  })

  it("freezes exposed limits against external mutation", () => {
    const limits = { costUsd: 1 }
    const budget = createRunBudget(limits, false)
    limits.costUsd = 999
    expect(budget.limits).toEqual({ costUsd: 1 })
    expect(snapshotOf(budget).limits).toEqual({ costUsd: 1 })
    expect(budget.check().ok).toBe(true)
    expect(() => {
      budget.limits.costUsd = 999
    }).toThrow()
    expect(budget.limits).toEqual({ costUsd: 1 })
  })

  it("inherits subtracted child limits and fails closed on corrupt parent spend", () => {
    const snapshot = { limits: { steps: 10, tokens: 100, activeSeconds: 60, costUsd: 1 }, explicitCost: false }
    const child = childSnapshotFor(snapshot, { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, computeSeconds: 5, costUsd: 0.25, steps: 2 })
    expect(child.limits).toMatchObject({ steps: 8, tokens: 50, activeSeconds: 55, costUsd: 0.75 })
    const corrupt = childSnapshotFor(snapshot, { inputTokens: NaN, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, computeSeconds: -3, costUsd: -1, steps: 2 })
    expect(corrupt.limits.tokens).toBe(0)
    expect(corrupt.limits.costUsd).toBe(0)
    expect(corrupt.limits.activeSeconds).toBe(0)
    expect(corrupt.limits.steps).toBe(8)
  })
})

describe("waits versus active work", () => {
  function scriptedBrain(turns: AssistantTurn[]): { brain: Brain; calls: () => number } {
    let index = 0
    return {
      calls: () => index,
      brain: {
        buildContext: async (): Promise<BrainContext> => ({ sessionKey: input.sessionKey, agentId: AGENT }),
        step: async (): Promise<AssistantTurn> => {
          const turn = turns[Math.min(index, turns.length - 1)]
          index += 1
          if (turn === undefined) throw new Error("no scripted turn")
          return turn
        },
        shouldCompact: () => false,
        compact: async (ctx) => ctx,
      },
    }
  }

  it("excludes a full event-wait deadline from active time and still completes", async () => {
    const raw = createMemoryStore()
    await raw.put("runs", runDoc())
    const store = requestScopedStore(raw)
    const enqueuer = new NoopEnqueuer()
    const brain = scriptedBrain([
      { text: "", toolCalls: [{ id: "c1", name: "wait_for", arguments: { filter: { source: "github" }, timeout: "1500ms" } }], usage, stopReason: "tool_calls" },
      { text: "done", toolCalls: [], usage, stopReason: "stop" },
    ])
    const waitTool = createWaitForTool({ store, enqueuer })
    const services: RunServices = {
      store, blobs: createMemoryBlobStore(),
      enqueuer,
      brain: brain.brain,
      toolRegistry: { forAgent: async () => [waitTool], get: (name: string) => (name === "wait_for" ? waitTool : undefined) },
    }
    const clock = { now: Date.now() }
    const ctx = testContext(clock)
    const outcome = await runLoop(ctx, services, input, "run-1", { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED)
    expect(outcome).toBe("completed")
    expect(JSON.stringify((await raw.list("transcripts", { limit: 50 })).items)).toContain("timed out")
    expect((await raw.list("subscriptions", { limit: 10 })).items).toHaveLength(0)
    expect((await raw.list("requests", { limit: 10 })).items).toHaveLength(0)
    const computeSeconds = (await raw.get("runs", "run-1"))?.usage?.computeSeconds ?? Number.NaN
    expect(computeSeconds).toBeLessThan(1.5)
  })
})

describe("terminal model failures keep honest accounting", () => {
  function terminalWorld(): Promise<{ store: Store; raw: ReturnType<typeof createMemoryStore> }> {
    return (async () => {
      const raw = createMemoryStore()
      const at = new Date().toISOString()
      await raw.put("runs", {
        id: "terminal-run", agentId: "terminal-agent", conversationId: "terminal-chat", title: "terminal",
        status: "running", kind: "chat", steps: [],
        usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
        startedAt: at, lastActivityAt: at,
      })
      return { store: requestScopedStore(raw), raw }
    })()
  }

  function terminalInput(): RunInput {
    const at = new Date().toISOString()
    return {
      agentId: "terminal-agent", conversationId: "terminal-chat", sessionKey: "terminal-agent:terminal-chat",
      wakeEvents: [{
        id: "terminal-wake", ownerId: "terminal-owner", agentId: "terminal-agent", conversationId: "terminal-chat",
        sessionKey: "terminal-agent:terminal-chat", kind: "user_message", origin: { type: "user" },
        trusted: true, priority: "user", payload: { text: "QA" }, at, status: "accepted",
      }],
    }
  }

  function terminalContext(): RunContext {
    let clock = 1000
    const used = new Set<string>()
    let seq = 0
    return {
      rand: { uuidv4: () => "id-" + String(seq++) },
      localDate: { now: () => { clock += 200; return clock } },
      run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
        if (used.has(name)) throw new Error("duplicate durable step: " + name)
        used.add(name)
        return RestatePromise.resolve(action())
      },
      awakeable: <T>(): { id: string; promise: RestatePromise<T> } => {
        throw new Error("no human waits in budget tests")
      },
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    }
  }

  function timeoutBrain(calls: { count: number }): Brain {
    return {
      buildContext: async () => ({ sessionKey: "terminal-agent:terminal-chat", agentId: "terminal-agent" }),
      step: async () => {
        calls.count += 1
        throw new ModelTurnError("first_response_timeout", "QA first response timeout")
      },
      shouldCompact: () => false,
      compact: async (ctx) => ctx,
    }
  }

  function timeoutServices(store: Store, brain: Brain): RunServices {
    return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: { forAgent: async () => [], get: () => undefined } }
  }

  it("persists the journaled active time of a permanent timeout without retry", async () => {
    const { store, raw } = await terminalWorld()
    const calls = { count: 0 }
    const brainCtx = { sessionKey: "terminal-agent:terminal-chat", agentId: "terminal-agent" }
    await expect(runLoop(terminalContext(), timeoutServices(store, timeoutBrain(calls)), terminalInput(), "terminal-run", brainCtx, NEVER_CANCELLED)).rejects.toThrow("QA first response timeout")
    expect(calls.count).toBe(1)
    expect((await raw.get("runs", "terminal-run"))?.usage?.computeSeconds).toBe(0.2)
  })

  it("prefers the spend-authority block when a terminal attempt also exhausts the budget", async () => {
    const { store, raw } = await terminalWorld()
    const settings: AppSettings & { id: string } = {
      id: "app-settings-terminal-owner",
      general: { launchAtLogin: false, language: "en" },
      appearance: { theme: "system", density: "comfortable", accent: "blue" },
      notifications: [],
      usage: { activeSeconds: 0.1 },
      yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: "not_requested" },
      connections: { serverUrl: "", modelProviders: [] },
      privacy: { dataRetentionDays: 0, trainingOptIn: false },
      advanced: { releaseTrack: "stable", logsEnabled: false, networkDebugger: false },
    }
    await raw.put("settings", settings)
    const calls = { count: 0 }
    const brainCtx = { sessionKey: "terminal-agent:terminal-chat", agentId: "terminal-agent" }
    const outcome = await runLoop(terminalContext(), timeoutServices(store, timeoutBrain(calls)), terminalInput(), "terminal-run", brainCtx, NEVER_CANCELLED)
    expect(outcome).toBe("blocked")
    expect(calls.count).toBe(1)
    expect((await raw.get("runs", "terminal-run"))?.error).toContain("active time budget")
    expect((await raw.get("runs", "terminal-run"))?.usage?.computeSeconds).toBe(0.2)
  })
})
