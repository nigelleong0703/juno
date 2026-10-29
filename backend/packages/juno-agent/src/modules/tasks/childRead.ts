/**
 * Reading side of the PH12 child-task domain: status, parent-visible result and the child PLAN
 * namespace. A child run owns its OWN plan (keyed by the child run id) so the child's completion gate
 * can never see the parent's open tasks — the same-agent/same-conversation deadlock — while the
 * parent's root plan is left untouched and both stay attributed in the ongoing list.
 */
import type { Store } from '../../contracts/index.js';
import type { BudgetLimits } from '../../execution/usage/index.js';
import type { Run, RunUsage } from '@agent-desktop/public-contracts';
import type { ChildBudgetSnapshot } from './child-budget.js';
import { createHash } from 'node:crypto';

export const CHILD_RESULT_MAX_CHARS = 4_000;
export const CHILD_LIST_PAGE = 100;

/** A child run carries its canonical session key and plan id, so neither is invented at read time. */
export interface ChildRun extends Run {
  parentRunId?: string;
  /** The run at the top of this child's task tree and its level in it (BACKEND 6.5); written once at spawn. */
  rootRunId?: string;
  depth?: number;
  childSessionKey?: string;
  planId?: string;
  /** Delivery state of the reserved run: 'pending' until the workflow accepts it, then 'accepted'. */
  dispatch?: 'pending' | 'accepted';
  dispatchError?: string;
  /**
   * Private frozen budget inherited at spawn (limits + parent usage snapshot). Never a public
   * control: the child must not reread changed global settings; the core (Jason/Dalton) reads this
   * snapshot instead. Typed here so the row preserves it without a public contract field.
   */
  budgetSnapshot?: ChildBudgetSnapshot;
  /** Immutable full prompt stored at reservation, so a later-step retry redelivers the same task. */
  childPrompt?: string;
  /** Jason's canonical frozen snapshot (read-only here; validated via his parse guard). */
  executionBudget?: { limits: BudgetLimits; explicitCost: boolean };
  /** Background child (spawned with notify): the session it reports to and its chain position. */
  notifyParent?: { ownerId: string; agentId: string; conversationId: string; chainId: string; generation: number };
  /** A continuation (child_message on a finished child): the earlier run whose transcript it was seeded from. */
  continues?: string;
  /** Tool narrowing from child_spawn `tools`, fixed at reservation: only these names may run in this child. */
  allowedTools?: string[];
  /** child_spawn `fast`, fixed at reservation: the child's model is the fast model when one resolves (see buildContext). */
  fastModel?: true;
  /** child_spawn `deep`, fixed at reservation: the child runs at the deep reasoning tier (see buildContext). */
  deepEffort?: true;
  /** Full final result when it outgrew childResult: an output artifact readable with output_read. */
  childResultRef?: string;
  /**
   * Private feed-card origin: set at spawn only when the spawning run was itself
   * directly card-eligible (a user message in this chat). Never a public control
   * and never model-set; feed_post requires it for an async task_done card, so a
   * bare kind=chat parent plus a notify link alone can never authorize a card.
   */
  feedCardUserOrigin?: true;
}
export interface ChildStatus {
  runId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  sessionKey: string;
  planId: string;
  title: string;
  status: Run['status'];
  depth: number;
  result: string | null;
  /** Artifact ref of the full result when it was longer than `result`. */
  resultRef: string | null;
  /** Spawned with notify: reports back by itself, so it never holds the parent's final reply. */
  background: boolean;
}

/**
 * The child's OWN canonical plan id: derived from (agent, conversation, child run) so it is stable
 * across a replay and distinct from the parent's root plan id for the same conversation.
 */
/** A child id derived from (owner, parent run, step): a replay resolves the SAME run, never a new one. */
export function childRunId(input: { ownerId: string; parentRunId: string; callId: string }): string {
  return 'run_child_' + createHash('sha256').update(input.ownerId + '|' + input.parentRunId + '|' + input.callId).digest('hex').slice(0, 12);
}
/** The canonical child session: distinct from the parent session, derived and stored, never invented. */
export function childSessionKey(agentId: string, conversationId: string, runId: string): string {
  return agentId + ':' + conversationId + '::child:' + runId;
}
export function childPlanId(agentId: string, conversationId: string, childRunId: string): string {
  return 'plan_child_' + createHash('sha256').update(agentId + '|' + conversationId + '|' + childRunId).digest('hex').slice(0, 16);
}

export function isTerminal(status: Run['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'blocked';
}

/**
 * Every child of a parent, read through the indexed parent link page by page, so a waiter never mistakes a
 * partial list for "all done" and a canceller never sees "nothing left to stop" too early.
 */
export async function listChildTasks(store: Store, parentRunId: string): Promise<ChildStatus[]> {
  const children: ChildStatus[] = [];
  for (const run of await childRunsOf(store, parentRunId)) children.push(await toStatus(store, run));
  return children;
}

/** The raw child rows of one parent (the walk behind listChildTasks; budget reads need the usage too). */
export async function childRunsOf(store: Store, parentRunId: string): Promise<ChildRun[]> {
  const children: ChildRun[] = [];
  let cursor: string | undefined;
  do {
    // The indexed parent link: the cost is this parent's children, not the owner's whole run history.
    const listed = await store.list('runs', { where: { parentId: parentRunId }, limit: CHILD_LIST_PAGE, orderBy: 'at', order: 'asc', ...(cursor === undefined ? {} : { cursor }) });
    children.push(...listed.items);
    cursor = listed.nextCursor;
  } while (cursor !== undefined);
  return children;
}

/** An all-zero usage: the start of a sum. */
export function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0, costKnown: true, measured: true };
}

/**
 * `start` plus the usage of every descendant of `parentRunId` (children, grandchildren, ...), walked
 * through each row's childRunIds links so a check costs one read per child, not a scan of every run.
 * The parent's own row is never added, so a caller that holds the parent's own usage does not count it twice.
 */
export async function descendantUsage(store: Store, parentRunId: string, start: RunUsage): Promise<RunUsage> {
  const sum: RunUsage = { ...start };
  const seen = new Set<string>([parentRunId]);
  const queue = [parentRunId];
  for (let index = 0; index < queue.length; index += 1) {
    const row = await store.get('runs', queue[index] ?? '');
    for (const childId of row?.childRunIds ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = await store.get('runs', childId);
      if (child === null) continue;
      const spent = child.usage;
      sum.inputTokens += spent.inputTokens;
      sum.outputTokens += spent.outputTokens;
      sum.cacheReadTokens = (sum.cacheReadTokens ?? 0) + (spent.cacheReadTokens ?? 0);
      sum.cacheWriteTokens = (sum.cacheWriteTokens ?? 0) + (spent.cacheWriteTokens ?? 0);
      sum.computeSeconds += spent.computeSeconds;
      sum.costUsd += spent.costUsd;
      sum.steps += spent.steps;
      // Unknown spend anywhere below stays unknown (a missing flag is not a false one).
      if (spent.measured === false) sum.measured = false;
      if (spent.costKnown === false) sum.costKnown = false;
      queue.push(childId);
    }
  }
  return sum;
}

export async function readChildTask(store: Store, runId: string): Promise<ChildStatus | null> {
  const run: ChildRun | null = await store.get('runs', runId);
  if (run === null || run.parentRunId === undefined) return null;
  return toStatus(store, run);
}

export async function toStatus(store: Store, run: ChildRun): Promise<ChildStatus> {
  return {
    runId: run.id,
    parentRunId: run.parentRunId ?? '',
    agentId: run.agentId,
    conversationId: run.conversationId ?? '',
    sessionKey: run.childSessionKey ?? '',
    planId: run.planId ?? '',
    title: run.title,
    status: run.status,
    depth: await depthOf(store, run.id),
    // CT: the parent reader reads the exact-run result from the canonical stored row. Active or
    // unfinished children without one read as null directly — never a conversation-wide scan.
    result: run.childResult ?? null,
    resultRef: run.childResultRef ?? null,
    background: run.notifyParent !== undefined,
  };
}

/** Depth in the child chain, walked through durable parent links (bounded by the hop limit). */
export async function depthOf(store: Store, runId: string): Promise<number> {
  let depth = 0;
  let current: string | undefined = runId;
  while (current !== undefined && depth <= 8) {
    const run: ChildRun | null = await store.get('runs', current);
    if (run === null) break;
    current = run.parentRunId;
    if (current !== undefined) depth += 1;
  }
  return depth;
}
