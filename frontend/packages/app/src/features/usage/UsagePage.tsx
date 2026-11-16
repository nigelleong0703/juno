import { Collapsible, CollapsibleContent, CollapsibleTrigger, PageHeader, ScrollArea, cn } from "@agent-desktop/ui";
import { CARD_SURFACE, SECTION_LABEL } from "../../components/page/PageFrame";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useAgents, useUsage } from "../../data/queries";
import { formatCount, formatUsd } from "../../lib/format";
import { t } from "../../lib/i18n";
import { UsageLedger } from "./UsageLedger";
import { runsLabel, spendLabel } from "./usageLabels";

/**
 * Usage (§4.16): this week's spend against the included limit, then the same number broken down
 * per agent and per app. Secondary page — reached from the user menu or ⌘K (修订 v0.3).
 */
export function UsagePage() {
  const { data: usage, isLoading, isError, refetch } = useUsage();
  const { data: agents } = useAgents();

  const agentById = (id: string) => agents?.find((entry) => entry.id === id);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader title={t("usage.title")} />

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
            <div className="max-w-2xl space-y-8">
              {/* One focal point: the week's spend against the included limit (the iPhone's summary card). */}
              <section className={cn("space-y-3 px-5 py-4", CARD_SURFACE)}>
                <p className="text-center text-base text-fg">
                  {spendLabel(usage.week)} of {limitLabel(usage.week.limitUsd)} {t("usage.weekTitle").toLowerCase()}
                </p>
                {usage.week.measured === false && (
                  <p className="text-center text-xs text-fg-subtle">
                    Token totals unknown: some runs reported no usage. Cost is unknown, not zero.
                  </p>
                )}
                <div
                  role="meter"
                  aria-label={t("usage.weekTitle")}
                  aria-valuemin={0}
                  aria-valuemax={usage.week.limitUsd}
                  aria-valuenow={usage.week.costUsd}
                  className="h-2.5 w-full overflow-hidden rounded-full bg-bg-subtle"
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-300",
                      usage.week.percent > 0.85 ? "bg-warning" : "bg-fg",
                    )}
                    style={{ width: `${Math.min(100, Math.round(usage.week.percent * 100))}%` }}
                  />
                </div>
              </section>

              <section className="space-y-2">
                <h2 className={SECTION_LABEL}>{t("usage.byAgent")}</h2>
                <ul className={cn("p-1.5", CARD_SURFACE)}>
                  {usage.byAgent
                    .filter((entry) => entry.runs > 0)
                    .sort((a, b) => b.costUsd - a.costUsd)
                    .map((entry) => {
                      const agent = agentById(entry.agentId);
                      return (
                        <li key={entry.agentId} className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
                          {agent && <AgentAvatar agentId={agent.id} avatar={agent.avatar} size="md" />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-fg">
                              {agent?.name ?? entry.agentId.replace("agent-", "")}
                            </div>
                            <div className="text-xs text-fg-subtle">{runsLabel(entry.runs)}</div>
                          </div>
                          <span className="shrink-0 text-right text-sm tabular-nums text-fg-muted">{spendLabel(entry)}</span>
                        </li>
                      );
                    })}
                </ul>
              </section>

              <Collapsible>
                <CollapsibleTrigger>Details and ledger</CollapsibleTrigger>
                <CollapsibleContent className="space-y-8 pt-4">
                  <dl className="grid grid-cols-3 gap-4">
                    <Stat label={t("usage.tokens")} value={formatCount(usage.week.inputTokens + usage.week.outputTokens)} />
                    <Stat label={t("usage.compute")} value={`${formatCount(Math.round(usage.week.computeSeconds / 60))} min`} />
                    <Stat label={t("usage.runsLabel")} value={formatCount(usage.byAgent.reduce((sum, entry) => sum + entry.runs, 0))} />
                  </dl>
                  {usage.byApp.length > 0 && (
                    <section>
                      <h2 className="text-sm font-medium text-fg">By app</h2>
                      <ul className="mt-2">
                        {usage.byApp.map((entry) => (
                          <li key={entry.app} className="flex items-center gap-3 rounded-md px-2 py-2">
                            <span className="min-w-0 flex-1 truncate text-sm text-fg">{entry.app}</span>
                            <span className="text-xs text-fg-subtle">{runsLabel(entry.runs)}</span>
                            <span className="w-16 shrink-0 text-right text-sm tabular-nums text-fg">{spendLabel(entry)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <UsageLedger />
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** "$10" for a whole-dollar limit, "$7.50" otherwise. */
function limitLabel(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : formatUsd(amount);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums text-fg">{value}</dd>
    </div>
  );
}
