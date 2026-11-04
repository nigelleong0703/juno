/**
 * The home sync of a run happens where the computer is reached (BACKEND 5.3): after the first computer tool of a run, and after each
 * tool that may have changed files, so the mirror the next context reads is current. A context build itself never contacts the computer.
 * The sync is the passive one (it never wakes a computer); it runs after the tool, when the computer has just answered.
 */
import type { ToolContext, ToolResult } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { readOwnerTimeZone } from '../../execution/brain/context.js';
import { changesFiles } from './paths.js';
import { loadHomeView, type HomeDeps } from './service.js';

/** Runs that already had their first computer-tool sync, oldest first and bounded (a run id is never reused). */
const syncedRuns = new Set<string>();
const MAX_TRACKED_RUNS = 2_000;

function firstComputerToolOf(runId: string): boolean {
  if (syncedRuns.has(runId)) return false;
  syncedRuns.add(runId);
  if (syncedRuns.size > MAX_TRACKED_RUNS) syncedRuns.delete(syncedRuns.values().next().value as string);
  return true;
}

async function syncHome(deps: HomeDeps, ctx: ToolContext): Promise<void> {
  const agent = await deps.store.get('agents', ctx.agentId);
  const agentOwnerId = agent === null ? undefined : docOwner(agent);
  const timeZone = await readOwnerTimeZone(deps.store, ctx.ownerId);
  await loadHomeView(deps, { ownerId: ctx.ownerId, ...(agentOwnerId === undefined ? {} : { agentOwnerId }), agentId: ctx.agentId, seq: 0, sync: true, ...(timeZone === undefined ? {} : { timeZone }) });
}

/** Wrap a tool that reaches the computer. `deps` is read per call; absent (no computer) means no sync. A sync never fails the tool. */
export function withHomeSync<T extends { name: string; execute(args: unknown, ctx: ToolContext): Promise<ToolResult> }>(tool: T, deps: () => HomeDeps | undefined): T {
  return {
    ...tool,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(args, ctx);
      const home = deps();
      if (result.isError === true || home === undefined || ctx.ownerId === '') return result;
      if (firstComputerToolOf(ctx.runId) || changesFiles(tool.name)) await syncHome(home, ctx).catch(() => undefined);
      return result;
    },
  };
}
