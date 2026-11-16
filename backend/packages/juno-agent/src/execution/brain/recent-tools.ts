/**
 * The tools this conversation used lately, kept in the model's short list so the next run does not pay a tool_search round trip
 * to find them again (live: 45% of tool_search calls over a week fetched a tool the same chat had already used in an earlier run).
 *
 * Read once per run and journaled (run-loop.ts), and read the same way by the warm-up (warm.ts), so both send the same tools array.
 * Only completed runs count, so the run that is starting and a warm-up before it see the same set. The names are sorted, so the
 * set changes the tools array only when a tool enters or leaves it, not when the same tools are used in another order.
 */
import type { Store } from '../../contracts/index.js';
import { isDiscoveryTool } from '../../modules/tools/tools/toolSearch.js';

/** How many of the conversation's latest completed runs are read. */
export const RECENT_RUNS = 10;
/** At most this many tools are kept visible this way. */
export const RECENT_TOOLS_MAX = 8;

export async function recentlyUsedTools(store: Store, conversationId: string): Promise<string[]> {
  const runs = await store.list('runs', { where: { conversationId, status: 'completed' }, orderBy: 'at', order: 'desc', limit: RECENT_RUNS }).catch(() => null);
  if (runs === null) return [];
  // Newest run first, and within a run the latest step first, so the cap keeps the most recently used tools.
  const seen: string[] = [];
  for (const run of runs.items) {
    const steps = await store.list('steps', { where: { runId: run.id }, orderBy: 'at', order: 'desc', limit: 200 }).catch(() => null);
    for (const step of steps?.items ?? []) {
      const tool = step.tool;
      if (tool === undefined || step.status !== 'completed' || step.internal === true || isDiscoveryTool(tool) || seen.includes(tool)) continue;
      seen.push(tool);
      if (seen.length >= RECENT_TOOLS_MAX) return seen.sort();
    }
  }
  return seen.sort();
}
