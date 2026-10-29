import { PageHeader, ScrollArea, cn } from "@agent-desktop/ui";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useAgents, useUsage } from "../../data/queries";
import { formatCount, formatUsd } from "../../lib/format";
import { t } from "../../lib/i18n";
import { UsageLedger } from "./UsageLedger";

/** A spend total with an unknown price renders as unknown, never as a free $0.00. */
function spendLabel(entry: { costUsd: number; costKnown?: boolean }): string {
  return entry.costKnown === false ? "Unknown" : formatUsd(entry.costUsd);
}

/**
 * Usage (§4.16): this week's spend against the included limit, then the same number broken down
 * per agent and per app. Secondary page — reached from the user menu or ⌘K (修订 v0.3).
 */
export function UsagePage() {
  const { data: usage, isLoading, isError, refetch } = useUsage();
  const { data: agents } = useAgents();

  const agentById = (id: string) => agents?.find((entry) => entry.id === id);
  const maxAgentCost = Math.max(1, ...(usage?.byAgent.map((entry) => entry.costUsd) ?? [1]));
  const totalRuns = usage?.byAgent.reduce((sum, entry) => sum + entry.runs, 0) ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader title={t("usage.title")} subtitle={usage ? t("usage.weekTitle") : undefined} />

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 py-4">
          {isLoading ? (
            <p className="text-sm text-fg-muted">{t("common.loading")}</p>
          ) : isError || !usage ? (
            <div className="flex items-center gap-3 text-sm text-fg-muted">
              {t("common.error")}
              <button
                type="button"
                className="text-accent-link underline-offset-2 hover:underline"
                onClick={() => void refetch()}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <div className="space-y-10">
              {/* One focal point: the week's spend against the included limit. */}
              <section>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums text-fg">
                    {spendLabel(usage.week)}
                  </span>
                  <span className="text-sm text-fg-muted">
                    of {formatUsd(usage.week.limitUsd)} {t("usage.included").toLowerCase()}
                  </span>
                </div>
                {usage.week.measured === false && (
                  <p className="mt-1 text-xs text-fg-subtle">
                    Token totals unknown: some runs reported no usage. Cost is unknown, not zero.
                  </p>
                )}
                <div
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={usage.week.limitUsd}
                  aria-valuenow={usage.week.costUsd}
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle"
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-300",
                      usage.week.percent > 0.85 ? "bg-warning" : "bg-fg",
                    )}
                    style={{ width: `${Math.min(100, Math.round(usage.week.percent * 100))}%` }}
                  />
                </div>

                <dl className="mt-6 grid grid-cols-3 gap-4">
                  <Stat
                    label={t("usage.tokens")}
                    value={formatCount(usage.week.inputTokens + usage.week.outputTokens)}
                  />
                  <Stat
                    label={t("usage.compute")}
                    value={`${formatCount(Math.round(usage.week.computeSeconds / 60))} min`}
                  />
                  <Stat label="Runs" value={formatCount(totalRuns)} />
                </dl>
              </section>

              <section>
                <h2 className="text-sm font-medium text-fg">{t("usage.byAgent")}</h2>
                <ul className="mt-2">
                  {usage.byAgent
                    .filter((entry) => entry.runs > 0)
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((entry) => {
                      const agent = agentById(entry.agentId);
                      return (
                        <li
                          key={entry.agentId}
                          className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/40"
                        >
                          {agent && <AgentAvatar agentId={agent.id} avatar={agent.avatar} size="sm" />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-fg">
                              {agent?.name ?? entry.agentId.replace("agent-", "")}
                            </div>
                            <div className="text-xs text-fg-subtle">
                              {t("usage.runs", { count: entry.runs })}
                            </div>
                          </div>
                          <div className="hidden w-40 sm:block">
                            <div className="h-1 w-full overflow-hidden rounded-full bg-bg-subtle">
                              <div
                                className="h-full rounded-full bg-fg-muted"
                                style={{
                                  width: `${Math.round((entry.costUsd / maxAgentCost) * 100)}%`,
                                }}
                              />
                            </div>
                          </div>
                          <span className="w-16 shrink-0 text-right text-sm tabular-nums text-fg">
                            {spendLabel(entry)}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </section>

              {usage.byApp.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-fg">By app</h2>
                <ul className="mt-2">
                  {usage.byApp.map((entry) => (
                    <li
                      key={entry.app}
                      className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{entry.app}</span>
                      <span className="text-xs text-fg-subtle">
                        {t("usage.runs", { count: entry.runs })}
                      </span>
                      <span className="w-16 shrink-0 text-right text-sm tabular-nums text-fg">
                        {spendLabel(entry)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              )}

              <UsageLedger />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums text-fg">{value}</dd>
    </div>
  );
}
