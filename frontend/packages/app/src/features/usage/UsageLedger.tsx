import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { useAgents } from "../../data/queries";
import { formatCount, formatUsd } from "../../lib/format";

const LEDGER_PAGE_LIMIT = 25;
const FIRST_LEDGER_CURSOR: string | undefined = undefined;

/** A spend with an unknown price renders as unknown, never as a free $0.00. */
function spendLabel(entry: { costUsd: number; costKnown?: boolean }): string {
  return entry.costKnown === false ? "Unknown" : formatUsd(entry.costUsd);
}

/** Unmeasured counters are unknown, not a real zero. */
function tokenLabel(entry: { measured?: boolean }, count: number): string {
  return entry.measured === false ? "Unknown" : formatCount(count);
}

/**
 * Ledger: every run's spend, newest first, with an agent filter and per-model totals. With `agentId` it shows
 * one agent's runs only (the agent's own page) and has no filter.
 */
export function UsageLedger({ agentId: scopedAgentId }: { agentId?: string }) {
  const client = useClient();
  const { data: agents } = useAgents();
  const [pickedAgentId, setAgentId] = useState("");
  const agentId = scopedAgentId ?? pickedAgentId;
  const ledger = useInfiniteQuery({
    queryKey: ["usage", "ledger", agentId],
    initialPageParam: FIRST_LEDGER_CURSOR,
    queryFn: ({ pageParam }) =>
      client.usage.ledger({
        limit: LEDGER_PAGE_LIMIT,
        ...(agentId === "" ? {} : { agentId }),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = ledger.data?.pages.flatMap((page) => page.items) ?? [];
  const byModel = ledger.data?.pages[0]?.byModel ?? [];
  const agentName = (id: string) => agents?.find((entry) => entry.id === id)?.name ?? id;

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-fg">Ledger</h2>
        {scopedAgentId === undefined && (
          <select
            aria-label="Filter ledger by agent"
            className="h-8 rounded-md bg-bg-subtle px-2 text-sm text-fg ring-1 ring-border"
            value={pickedAgentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">All agents</option>
            {agents?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {ledger.isError ? (
        <p className="mt-2 text-sm text-fg-muted">
          Could not load the ledger.{" "}
          <button
            type="button"
            className="text-accent-link underline-offset-2 hover:underline"
            onClick={() => void ledger.refetch()}
          >
            Retry
          </button>
        </p>
      ) : ledger.isLoading ? (
        <p className="mt-2 text-sm text-fg-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">No runs yet.</p>
      ) : (
        <>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
            {byModel.map((entry) => (
              <li key={entry.model}>
                {entry.model}: {spendLabel(entry)} · {formatCount(entry.runs)} runs
              </li>
            ))}
          </ul>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-fg-subtle">
                <tr>
                  <th className="py-1 pr-3 font-normal">Started</th>
                  <th className="py-1 pr-3 font-normal">Agent</th>
                  <th className="py-1 pr-3 font-normal">Model</th>
                  <th className="py-1 pr-3 text-right font-normal">In</th>
                  <th className="py-1 pr-3 text-right font-normal">Out</th>
                  <th className="py-1 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody className="text-fg">
                {rows.map((row) => (
                  <tr key={row.runId} className="border-t border-border">
                    <td className="py-1.5 pr-3 tabular-nums">
                      {new Date(row.startedAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3">
                      {agentName(row.agentId)}
                      {row.parentRunId !== undefined && (
                        <span className="ml-1 text-fg-subtle">(child of {row.parentRunId})</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{row.model ?? "unknown"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {tokenLabel(row, row.inputTokens)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {tokenLabel(row, row.outputTokens)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{spendLabel(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ledger.hasNextPage && (
            <button
              type="button"
              className="mt-3 text-sm text-accent-link underline-offset-2 hover:underline disabled:opacity-50"
              disabled={ledger.isFetchingNextPage}
              onClick={() => void ledger.fetchNextPage()}
            >
              Load more
            </button>
          )}
        </>
      )}
    </section>
  );
}
