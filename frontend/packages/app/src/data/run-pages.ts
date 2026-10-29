import type { ApiClient, Run, RunsListParams } from "@agent-desktop/client";

/**
 * Read every cursor page of `runs.list` into the one flat list the cache holds.
 *
 * The backend returns runs oldest-first within the window it is given and hands back a
 * `nextCursor` for anything further back; the newest running run for a group member routinely
 * sits on a later page than the first (owner baseline 2026-10-08: the members popover showed a
 * stale run while a live one existed outside page one). Every request keeps the caller's filters
 * and only swaps in the cursor the previous page returned. A cursor the backend repeats raises
 * instead of paging forever, and the rejection reaches React Query so the surface can show it.
 */
export async function listAllRuns(client: ApiClient, params?: RunsListParams): Promise<Run[]> {
  const items: Run[] = [];
  const requested = new Set<string>();
  const first = params?.cursor ?? undefined;
  if (first) requested.add(first);
  let cursor = first;
  for (;;) {
    const page = await client.runs.list(cursor ? { ...params, cursor } : params);
    // Housekeeping runs (kind "background", e.g. memory jobs) never show as activity (mirrors the iPhone app).
    items.push(...page.items.filter((run) => run.kind !== "background"));
    const next = page.nextCursor;
    if (!next) return items;
    if (requested.has(next)) throw new Error(`runs.list repeated cursor ${next}`);
    requested.add(next);
    cursor = next;
  }
}
