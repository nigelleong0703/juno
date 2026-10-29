/**
 * Activity module: the owner's audit projection and usage aggregation.
 *
 * Audit is written by execution and only read here. Usage is a truthful sum over the owner's
 * runs in the window; app attribution is not recorded per run, so the byApp list stays empty
 * instead of inventing buckets.
 */
import type { ListPage, ListQuery, Store } from '@agent-desktop/contracts';
import type { AgentUsage, AuditEntry, ModelUsage, Run, Usage, UsageLedger, UsageLedgerEntry } from '@agent-desktop/public-contracts';

/** The included weekly usage allowance; a product constant, not measured data. */
export const INCLUDED_WEEKLY_LIMIT_USD = 10;

function emptyAgentUsage(agentId: string): AgentUsage {
  return { agentId, runs: 0, inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, costKnown: true, measured: true };
}

async function collectRuns(scoped: Store, where?: ListQuery['where']): Promise<Run[]> {
  const runs: Run[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await scoped.list('runs', { limit: 200, ...(where === undefined ? {} : { where }), ...(cursor === undefined ? {} : { cursor }) });
    runs.push(...page.items);
    if (!page.nextCursor) return runs;
    cursor = page.nextCursor;
  }
}

/** Runs that never recorded a model share one bucket instead of an invented name. */
const UNKNOWN_MODEL = 'unknown';

function ledgerEntry(run: Run): UsageLedgerEntry {
  return {
    runId: run.id,
    agentId: run.agentId,
    ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    ...(run.model === undefined ? {} : { model: run.model }),
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    costUsd: run.usage.costUsd,
    ...(run.usage.costKnown === undefined ? {} : { costKnown: run.usage.costKnown }),
    ...(run.usage.measured === undefined ? {} : { measured: run.usage.measured }),
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  };
}

function totalsByModel(runs: Run[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const run of runs) {
    const model = run.model ?? UNKNOWN_MODEL;
    const totals = byModel.get(model) ?? { model, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, measured: true };
    if (run.usage.costKnown !== true) totals.costKnown = false;
    if (run.usage.measured !== true) totals.measured = false;
    totals.runs += 1;
    totals.inputTokens += run.usage.inputTokens;
    totals.outputTokens += run.usage.outputTokens;
    totals.costUsd += run.usage.costUsd;
    byModel.set(model, totals);
  }
  return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export interface ActivityModule {
  listAudit(query: ListQuery): Promise<ListPage<AuditEntry>>;
  getUsage(windowStartIso: string): Promise<Usage>;
  /** Per-run spend, newest first, from the run rows; per-model totals cover every run matching the agent filter. */
  getLedger(query: ListQuery, agentId?: string): Promise<UsageLedger>;
}

export function createActivityModule(scoped: Store): ActivityModule {
  return {
    listAudit(query: ListQuery): Promise<ListPage<AuditEntry>> {
      return scoped.list('audit', { ...query, orderBy: query.orderBy ?? 'at', order: query.order ?? 'desc' });
    },

    async getLedger(query: ListQuery, agentId?: string): Promise<UsageLedger> {
      const where = agentId === undefined ? undefined : { agentId };
      const page = await scoped.list('runs', { ...query, orderBy: 'at', order: 'desc', ...(where === undefined ? {} : { where }) });
      return {
        items: page.items.map(ledgerEntry),
        nextCursor: page.nextCursor ?? null,
        byModel: totalsByModel(await collectRuns(scoped, where)),
      };
    },

    async getUsage(windowStartIso: string): Promise<Usage> {
      const byAgent = new Map<string, AgentUsage>();
      let inputTokens = 0;
      let outputTokens = 0;
      let computeSeconds = 0;
      let costUsd = 0;
      let costKnown = true;
      let measured = true;
      for (const run of await collectRuns(scoped)) {
        if (run.startedAt < windowStartIso) continue;
        if (run.usage.costKnown !== true) costKnown = false;
        if (run.usage.measured !== true) measured = false;
        inputTokens += run.usage.inputTokens;
        outputTokens += run.usage.outputTokens;
        computeSeconds += run.usage.computeSeconds;
        costUsd += run.usage.costUsd;
        const totals = byAgent.get(run.agentId) ?? emptyAgentUsage(run.agentId);
        if (run.usage.costKnown !== true) totals.costKnown = false;
        if (run.usage.measured !== true) totals.measured = false;
        totals.runs += 1;
        totals.inputTokens += run.usage.inputTokens;
        totals.outputTokens += run.usage.outputTokens;
        totals.computeSeconds += run.usage.computeSeconds;
        totals.costUsd += run.usage.costUsd;
        byAgent.set(run.agentId, totals);
      }
      return {
        week: {
          start: windowStartIso,
          end: new Date().toISOString(),
          inputTokens,
          outputTokens,
          computeSeconds,
          costUsd,
          costKnown,
          measured,
          limitUsd: INCLUDED_WEEKLY_LIMIT_USD,
          percent: INCLUDED_WEEKLY_LIMIT_USD > 0 ? costUsd / INCLUDED_WEEKLY_LIMIT_USD : 0,
        },
        byAgent: [...byAgent.values()],
        byApp: [],
      };
    },
  };
}
