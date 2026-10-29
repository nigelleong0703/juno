/**
 * The task tree (BACKEND 6.5): one observable projection of child runs, routine runs, background jobs and the agent's
 * declared tasks. Nothing here executes, retries or stops anything, and nothing is stored: every `AgentTask` is read
 * from the Postgres rows of the mechanism that owns the work (never process-local state, because workers run on
 * several processes), by a pure mapping from each source's state plus the persisted facts the write side records
 * (`rootRunId`, `depth`, `blockCause`, `effectReview`, `stopDelivery`).
 */
import { LIMITS, type BackgroundTask, type DeclaredTask, type Doc, type StopActor, type Store } from '../../contracts/index.js';
import type { ChildRun } from './childRead.js';
import type {
  AgentTask, OutcomeDetail, ReplyTarget, RunOrigin, RunUsage, TaskTree, WaitingFor, WorkKind, WorkOutcome, WorkStatus,
} from '@agent-desktop/public-contracts';
import type { StoredRun } from '../../contracts/index.js';
import { QUIET_RESULT_PREFIX } from '../tools/tools/finishQuietly.js';

/** A run row as the projection reads it: the stored run plus the child-reservation fields. */
export type WorkRun = StoredRun & ChildRun;

const LINE_MAX = 300;
const TITLE_MAX = 200;
export const TASKS_PAGE_DEFAULT = 50;
export const TASKS_PAGE_MAX = 200;

/** One display line: whitespace collapsed, first line only, bounded. */
export function oneLine(text: string, max = LINE_MAX): string {
  const first = text.trim().split('\n')[0] ?? '';
  const line = first.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure mapping: source state -> status / outcome. `unknown_effect` wins over everything else.
// ---------------------------------------------------------------------------------------------------------------------

export interface Verdict {
  status: WorkStatus;
  waitingFor?: WaitingFor;
  outcome?: WorkOutcome;
  outcomeDetail?: OutcomeDetail;
}

const ended = (outcome: WorkOutcome, outcomeDetail?: OutcomeDetail): Verdict => ({ status: 'ended', outcome, ...(outcomeDetail === undefined ? {} : { outcomeDetail }) });

const STOPPED_DETAIL = { owner: 'stopped_by_owner', agent: 'stopped_by_agent', system: 'stopped_by_system' } as const;

/** A stop that somebody asked for. A stop with no recorded requester (before this was written) is a plain cancellation. */
const cancelled = (by: StopActor | undefined): Verdict => ended('cancelled', by === undefined ? undefined : STOPPED_DETAIL[by]);

function blockedVerdict(cause: StoredRun['blockCause']): Verdict {
  switch (cause) {
    case 'needs_input': return ended('needs_input');
    case 'limit': return ended('failed', 'step_limit');
    case 'no_progress': return ended('failed', 'no_progress');
    case 'verification': return ended('failed', 'verification_failed');
    case 'unreadable': return ended('failed', 'state_unreadable');
    default: return ended('failed');
  }
}

/** A run's status. `waitingFor` is what its pending request asks (an approval or a question); an open effect review overrides it. */
export function runVerdict(run: Pick<WorkRun, 'status' | 'effectReview' | 'blockCause' | 'dispatchError' | 'stoppedBy'>, waitingFor: 'approval' | 'owner_input' = 'owner_input'): Verdict {
  const review = run.effectReview === 'open';
  switch (run.status) {
    case 'scheduled':
    case 'queued':
      return { status: 'queued', ...(run.dispatchError === undefined ? {} : { outcomeDetail: 'dispatch_failed' as const }) };
    case 'running':
      return review ? { status: 'waiting', waitingFor: 'effect_review' } : { status: 'running' };
    case 'waiting_for_input':
      return { status: 'waiting', waitingFor: review ? 'effect_review' : waitingFor };
    default:
  }
  if (review) return ended('unknown_effect', 'effect_review');
  switch (run.status) {
    case 'completed': return ended('done');
    case 'stopped': return cancelled(run.stoppedBy);
    case 'failed': return ended('failed');
    default: return blockedVerdict(run.blockCause);
  }
}

export function backgroundVerdict(task: Pick<BackgroundTask, 'kind' | 'status' | 'stopDelivery' | 'stoppedBy'>): Verdict {
  switch (task.status) {
    case 'running': return task.kind === 'wait' ? { status: 'waiting', waitingFor: 'event' } : { status: 'running' };
    case 'completed': return ended('done');
    case 'failed': return ended('failed');
    case 'timeout': return ended('failed', 'timed_out');
    // A background MCP call whose stop was only marked (the abort did not reach the call) may still have run on the server.
    default: return task.kind === 'mcp' && task.stopDelivery === 'marked' ? ended('unknown_effect', 'stop_unconfirmed') : cancelled(task.stoppedBy);
  }
}

export function declaredVerdict(task: Pick<DeclaredTask, 'status' | 'stoppedBy'>): Verdict {
  switch (task.status) {
    case 'running': return { status: 'running' };
    case 'waiting': return { status: 'waiting', waitingFor: 'owner_input' };
    case 'completed': return ended('done');
    case 'failed': return ended('failed');
    default: return cancelled(task.stoppedBy);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure mapping: one source row -> AgentTask
// ---------------------------------------------------------------------------------------------------------------------

/** A delegated child run; every child run is `kind: 'background'` with a parent. */
export function isSubagentRun(run: Pick<WorkRun, 'kind' | 'parentRunId'>): boolean {
  return run.kind === 'background' && run.parentRunId !== undefined;
}

/** A run a routine's schedule or monitor started (`Run.routineId`, 0.68.0); its children are subagents. */
export function isRoutineRun(run: Pick<WorkRun, 'parentRunId' | 'routineId'>): boolean {
  return run.parentRunId === undefined && run.routineId !== undefined;
}

/** Only a child run and a routine run are tasks; a plain chat run never is. */
export function isWorkRun(run: WorkRun): boolean {
  return isSubagentRun(run) || isRoutineRun(run);
}

const rootOriginOf = (run: Pick<WorkRun, 'origin' | 'rootOrigin'>): RunOrigin | undefined => run.rootOrigin ?? run.origin;

const BACKGROUND_KIND = { shell: 'command', mcp: 'connector', wait: 'wait' } as const;

function stamps(startedAt: string, updatedAt: string, finishedAt: string | undefined): Pick<AgentTask, 'startedAt' | 'updatedAt' | 'finishedAt'> {
  return { startedAt, updatedAt, ...(finishedAt === undefined ? {} : { finishedAt }) };
}

function verdictFields(verdict: Verdict): Pick<AgentTask, 'status' | 'waitingFor' | 'outcome' | 'outcomeDetail'> {
  return {
    status: verdict.status,
    ...(verdict.waitingFor === undefined ? {} : { waitingFor: verdict.waitingFor }),
    ...(verdict.outcome === undefined ? {} : { outcome: verdict.outcome }),
    ...(verdict.outcomeDetail === undefined ? {} : { outcomeDetail: verdict.outcomeDetail }),
  };
}

export interface RunTaskContext {
  /** The routine of a routine run, for where its result is delivered. */
  routine: Doc<'routines'> | null;
  /** What a run waiting for input is asked for. */
  waitingFor: 'approval' | 'owner_input';
}

/** A child run or routine run as a task; null for a plain run (or one with no origin yet). */
export function runAsTask(run: WorkRun, ctx: RunTaskContext): AgentTask | null {
  const origin = rootOriginOf(run);
  if (!isWorkRun(run) || origin === undefined) return null;
  const subagent = isSubagentRun(run);
  const verdict = runVerdict(run, ctx.waitingFor);
  const live = verdict.status !== 'ended';
  const step = run.steps.at(-1);
  // A run that ended through finish_quietly says why there was nothing to tell (BACKEND §3.3a), ahead of any model summary of its steps.
  const resultSource = run.quietReason !== undefined ? QUIET_RESULT_PREFIX + run.quietReason : subagent ? run.childResult : (run.summary ?? run.childResult);
  const resultLine = !live ? (resultSource ?? (run.status === 'failed' || run.status === 'blocked' ? run.error : undefined)) : undefined;
  const delivery = ctx.routine?.delivery;
  const replyTo: ReplyTarget = subagent
    ? (run.notifyParent === undefined ? { type: 'parent_run', runId: run.parentRunId ?? '' } : { type: 'session', agentId: run.notifyParent.agentId, conversationId: run.notifyParent.conversationId })
    : (delivery === undefined ? { type: 'none' } : { type: 'delivery', channel: delivery.channel, ...(delivery.target === undefined ? {} : { target: delivery.target }) });
  return {
    id: run.id,
    kind: subagent ? 'subagent' : 'routine',
    agentId: run.agentId,
    ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
    ...(run.parentRunId === undefined ? {} : { parentId: run.parentRunId }),
    rootRunId: run.rootRunId ?? run.id,
    depth: run.depth ?? 0,
    origin,
    mode: subagent ? (run.notifyParent === undefined ? 'awaited' : 'background') : 'scheduled',
    replyTo,
    ...verdictFields(verdict),
    title: oneLine(run.title, TITLE_MAX) || (subagent ? 'Subagent' : 'Routine run'),
    // The same "verb target" line the run view shows for its latest step.
    ...(live && step !== undefined ? { progress: oneLine(step.verb + ' ' + step.target) } : {}),
    ...(resultLine ? { resultLine: oneLine(resultLine) } : {}),
    // The run that started it; a routine's run is its own.
    runId: subagent ? run.parentRunId : run.id,
    ...(subagent ? { childRunId: run.id } : {}),
    ...(run.routineId === undefined ? {} : { routineId: run.routineId }),
    usage: run.usage,
    ...stamps(run.startedAt, run.finishedAt ?? run.lastActivityAt ?? run.startedAt, run.finishedAt),
  };
}

/** A background job, hanging under the run that started it. `parent` is that run (null: the run is gone, so there is no origin to show). */
export function backgroundAsTask(task: BackgroundTask, parent: WorkRun | null): AgentTask | null {
  const origin = parent === null ? undefined : rootOriginOf(parent);
  if (origin === undefined) return null;
  const verdict = backgroundVerdict(task);
  const outcome = task.outcome ?? (task.status === 'timeout' ? 'Timed out' : undefined);
  return {
    id: task.id,
    kind: BACKGROUND_KIND[task.kind],
    agentId: task.agentId,
    conversationId: task.conversationId,
    parentId: task.runId,
    rootRunId: task.rootRunId ?? task.runId,
    depth: (parent?.depth ?? 0) + 1,
    origin,
    mode: 'background',
    replyTo: task.notify ? { type: 'session', agentId: task.agentId, conversationId: task.conversationId } : { type: 'none' },
    ...verdictFields(verdict),
    title: oneLine(task.title ?? task.label, TITLE_MAX) || task.kind,
    ...(task.status === 'running' && task.kind === 'wait' ? { progress: oneLine('Waiting for ' + task.label) } : {}),
    ...(task.status !== 'running' && outcome !== undefined ? { resultLine: oneLine(outcome) } : {}),
    runId: task.runId,
    ...stamps(task.startedAt, task.endedAt ?? task.startedAt, task.endedAt),
  };
}

/** A task the agent declared, hanging under the run doing it. `run` is that run (null for a task no run owns). */
export function declaredAsTask(task: DeclaredTask, run: WorkRun | null): AgentTask | null {
  const origin = (run === null ? undefined : rootOriginOf(run)) ?? task.origin;
  if (origin === undefined) return null;
  const verdict = declaredVerdict(task);
  const text = task.outcome === undefined ? undefined : oneLine(task.outcome);
  return {
    id: task.id,
    kind: 'task',
    agentId: task.agentId,
    ...(task.conversationId === undefined ? {} : { conversationId: task.conversationId }),
    ...(task.runId === undefined ? {} : { parentId: task.runId }),
    rootRunId: run === null ? task.id : (run.rootRunId ?? run.id),
    depth: run === null ? 0 : (run.depth ?? 0) + 1,
    origin,
    mode: 'awaited',
    replyTo: { type: 'none' },
    ...verdictFields(verdict),
    title: oneLine(task.title, TITLE_MAX) || 'Task',
    // A waiting task's text says what the agent asked; a finished task's is its result.
    ...(task.status === 'waiting' ? { progress: text ?? task.progress } : task.status === 'running' && task.progress !== undefined ? { progress: oneLine(task.progress) } : {}),
    ...(verdict.status === 'ended' && text !== undefined ? { resultLine: text } : {}),
    ...(task.runId === undefined ? {} : { runId: task.runId }),
    ...stamps(task.startedAt, task.updatedAt, task.finishedAt),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading: hydrate source rows with the few rows the mapping needs, then map.
// ---------------------------------------------------------------------------------------------------------------------

const BATCH = 100;

/** Every row a query matches, page by page. For the live sets, which the concurrency limits keep small. */
async function drain<C extends 'runs' | 'agentTasks' | 'backgroundTasks' | 'requests'>(store: Store, collection: C, query: Parameters<Store['list']>[1]): Promise<Doc<C>[]> {
  const out: Doc<C>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(collection, { limit: 200, ...query, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

async function runsByIds(store: Store, ids: Iterable<string>): Promise<Map<string, WorkRun>> {
  const wanted = [...new Set(ids)];
  const found = new Map<string, WorkRun>();
  for (let index = 0; index < wanted.length; index += BATCH) {
    const chunk = wanted.slice(index, index + BATCH);
    const page = await store.list('runs', { where: { ids: chunk }, limit: chunk.length });
    for (const run of page.items) found.set(run.id, run);
  }
  return found;
}

interface Sources {
  declared: DeclaredTask[];
  background: BackgroundTask[];
  runs: WorkRun[];
}

/** Read what the mapping needs besides the rows themselves (parent runs, routines, the question a waiting run asks) and map. */
async function hydrate(store: Store, rows: Sources): Promise<AgentTask[]> {
  const parentIds = [...rows.declared.flatMap((task) => (task.runId === undefined ? [] : [task.runId])), ...rows.background.map((task) => task.runId)];
  const parents = await runsByIds(store, parentIds);
  const routines = new Map<string, Doc<'routines'>>();
  const routineIds = [...new Set(rows.runs.flatMap((run) => (run.routineId === undefined ? [] : [run.routineId])))];
  for (const id of routineIds) {
    const routine = await store.get('routines', id);
    if (routine !== null) routines.set(id, routine);
  }
  const out: AgentTask[] = [];
  for (const run of rows.runs) {
    const waitingFor = run.status === 'waiting_for_input' ? await waitingForOf(store, run.id) : 'owner_input';
    const task = runAsTask(run, { routine: run.routineId === undefined ? null : (routines.get(run.routineId) ?? null), waitingFor });
    if (task !== null) out.push(task);
  }
  for (const job of rows.background) {
    const task = backgroundAsTask(job, parents.get(job.runId) ?? null);
    if (task !== null) out.push(task);
  }
  for (const declared of rows.declared) {
    const task = declaredAsTask(declared, declared.runId === undefined ? null : (parents.get(declared.runId) ?? null));
    if (task !== null) out.push(task);
  }
  return out;
}

/** A waiting run asks for an approval when its pending request is one, otherwise for the owner's answer. */
async function waitingForOf(store: Store, runId: string): Promise<'approval' | 'owner_input'> {
  const pending = await store.list('requests', { where: { runId, status: 'pending' }, limit: 20 });
  return pending.items.some((request) => request.kind === 'approval') ? 'approval' : 'owner_input';
}

/** The task for one source row, as it is announced on `task.updated`. Null when the row is not a task. */
export async function projectRun(store: Store, run: WorkRun): Promise<AgentTask | null> {
  return (await hydrate(store, { declared: [], background: [], runs: [run] }))[0] ?? null;
}
export async function projectBackground(store: Store, task: BackgroundTask): Promise<AgentTask | null> {
  return (await hydrate(store, { declared: [], background: [task], runs: [] }))[0] ?? null;
}
export async function projectDeclared(store: Store, task: DeclaredTask): Promise<AgentTask | null> {
  return (await hydrate(store, { declared: [task], background: [], runs: [] }))[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------------------------------

export interface WorkFilter {
  agentId?: string;
  conversationId?: string;
  kind?: WorkKind;
  routineId?: string;
}

const LIVE_RUN = ['scheduled', 'queued', 'running', 'waiting_for_input'];
const ENDED_RUN = ['completed', 'failed', 'stopped', 'blocked'];
const LIVE_DECLARED = ['running', 'waiting'];
const ENDED_DECLARED = ['completed', 'failed', 'stopped'];
const LIVE_BACKGROUND = ['running'];
const ENDED_BACKGROUND = ['completed', 'failed', 'timeout', 'stopped'];
const BACKGROUND_STORE_KIND = { command: 'shell', connector: 'mcp', wait: 'wait' } as const;

type Position = { at: string; id: string };

const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Newest start first; equal starts by id, as bytes: a total order the keyset cursor can name. */
export function byStartDesc(a: Pick<AgentTask, 'startedAt' | 'id'>, b: Pick<AgentTask, 'startedAt' | 'id'>): number {
  return binary(b.startedAt, a.startedAt) || binary(b.id, a.id);
}

export function encodePosition(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

export function decodePosition(cursor: string): Position | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const at: unknown = Reflect.get(parsed, 'at');
    const id: unknown = Reflect.get(parsed, 'id');
    return typeof at === 'string' && typeof id === 'string' && Number.isFinite(Date.parse(at)) ? { at, id } : null;
  } catch {
    return null;
  }
}

/** Which sources a filter reads, with the indexed `where` each one gets. */
function sourceWheres(filter: WorkFilter) {
  const base = { ...(filter.agentId === undefined ? {} : { agentId: filter.agentId }), ...(filter.conversationId === undefined ? {} : { conversationId: filter.conversationId }) };
  const wants = (...kinds: WorkKind[]): boolean => filter.routineId === undefined && (filter.kind === undefined || kinds.includes(filter.kind));
  return {
    declared: wants('task') ? base : null,
    background: wants('command', 'connector', 'wait')
      ? { ...base, ...(filter.kind === undefined ? {} : { kind: BACKGROUND_STORE_KIND[filter.kind as keyof typeof BACKGROUND_STORE_KIND] }) }
      : null,
    subagents: wants('subagent') ? { ...base, kind: 'background', hasParent: true } : null,
    routines: filter.routineId === undefined && filter.kind !== undefined && filter.kind !== 'routine'
      ? null
      : { ...base, hasParent: false, ...(filter.routineId === undefined ? { hasRoutine: true } : { routineId: filter.routineId }) },
  };
}

/** The live tasks, whole: running, waiting and queued work is bounded by the concurrency limits, so there is no page. */
export async function listLiveWork(store: Store, filter: WorkFilter): Promise<AgentTask[]> {
  const wheres = sourceWheres(filter);
  const [declared, background, subagents, routines] = await Promise.all([
    wheres.declared === null ? [] : drain(store, 'agentTasks', { where: { ...wheres.declared, statuses: LIVE_DECLARED } }),
    wheres.background === null ? [] : drain(store, 'backgroundTasks', { where: { ...wheres.background, statuses: LIVE_BACKGROUND } }),
    wheres.subagents === null ? [] : drain(store, 'runs', { where: { ...wheres.subagents, statuses: LIVE_RUN } }),
    wheres.routines === null ? [] : drain(store, 'runs', { where: { ...wheres.routines, statuses: LIVE_RUN } }),
  ]);
  const tasks = await hydrate(store, { declared, background, runs: [...subagents, ...routines] });
  return tasks.sort((a, b) => binary(b.updatedAt, a.updatedAt) || binary(b.id, a.id));
}

/**
 * One page of ended tasks, newest start first. Each source is read with the same keyset position and N+1 rows, then
 * merged: the first N of the merge are exactly the next N of the whole, so equal start times neither repeat nor skip.
 */
export async function listEndedWork(store: Store, filter: WorkFilter, page: { cursor?: Position; limit: number }): Promise<{ items: AgentTask[]; next: Position | null }> {
  const wheres = sourceWheres(filter);
  const query = { orderBy: 'at' as const, order: 'desc' as const, limit: page.limit + 1, ...(page.cursor === undefined ? {} : { keyset: page.cursor }) };
  const [declared, background, subagents, routines] = await Promise.all([
    wheres.declared === null ? { items: [] as DeclaredTask[] } : store.list('agentTasks', { ...query, where: { ...wheres.declared, statuses: ENDED_DECLARED } }),
    wheres.background === null ? { items: [] as BackgroundTask[] } : store.list('backgroundTasks', { ...query, where: { ...wheres.background, statuses: ENDED_BACKGROUND } }),
    wheres.subagents === null ? { items: [] as WorkRun[] } : store.list('runs', { ...query, where: { ...wheres.subagents, statuses: ENDED_RUN } }),
    wheres.routines === null ? { items: [] as WorkRun[] } : store.list('runs', { ...query, where: { ...wheres.routines, statuses: ENDED_RUN } }),
  ]);
  const raw = [declared, background, subagents, routines];
  // A source that returned N+1 rows has more behind them; the merge may drop some of them from this page.
  const more = raw.some((source) => source.items.length > page.limit);
  const tasks = (await hydrate(store, { declared: declared.items, background: background.items, runs: [...subagents.items, ...routines.items] })).sort(byStartDesc);
  const items = tasks.slice(0, page.limit);
  const last = items.at(-1);
  const hasMore = tasks.length > page.limit || more;
  return { items, next: hasMore && last !== undefined ? { at: last.startedAt, id: last.id } : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Which run roots the tree that task or run `id` belongs to. A foreign or unknown id is null (the store is owner-scoped,
 * so a foreign row never reads). A task whose own run is gone (a meeting's task) is its own root.
 */
export async function rootRunIdOf(store: Store, id: string): Promise<string | null> {
  const run = await store.get('runs', id);
  if (run !== null) return run.rootRunId ?? run.id;
  const background = await store.get('backgroundTasks', id);
  if (background !== null) return background.rootRunId ?? background.runId;
  const declared = await store.get('agentTasks', id);
  if (declared === null) return null;
  const owner = declared.runId === undefined ? null : await store.get('runs', declared.runId);
  return owner === null ? declared.id : (owner.rootRunId ?? owner.id);
}

const addUsage = (sum: RunUsage, spent: RunUsage): void => {
  sum.inputTokens += spent.inputTokens;
  sum.outputTokens += spent.outputTokens;
  sum.cacheReadTokens = (sum.cacheReadTokens ?? 0) + (spent.cacheReadTokens ?? 0);
  sum.cacheWriteTokens = (sum.cacheWriteTokens ?? 0) + (spent.cacheWriteTokens ?? 0);
  sum.computeSeconds += spent.computeSeconds;
  sum.costUsd += spent.costUsd;
  sum.steps += spent.steps;
  // Unknown spend anywhere in the tree stays unknown (a missing flag is not a false one).
  if (spent.measured === false) sum.measured = false;
  if (spent.costKnown === false) sum.costKnown = false;
};

/**
 * Every task under one root run, breadth first from the root on the indexed parent link, no deeper than a child task
 * can be spawned. A tree whose root is a plain run has no task for the root itself; its direct children are the top level.
 */
export async function taskTree(store: Store, rootRunId: string): Promise<TaskTree | null> {
  const root = await store.get('runs', rootRunId);
  if (root === null) return null;
  const origin = rootOriginOf(root);
  const levels: WorkRun[][] = [[root]];
  for (let depth = 0; depth < LIMITS.chain.maxHopDepth; depth += 1) {
    const next: WorkRun[] = [];
    for (const parent of levels[depth] ?? []) next.push(...(await drain(store, 'runs', { where: { parentId: parent.id }, orderBy: 'at', order: 'asc' })));
    if (next.length === 0) break;
    levels.push(next);
  }
  const runs = levels.flat();
  const declared: DeclaredTask[] = [];
  const background: BackgroundTask[] = [];
  for (const run of runs) {
    declared.push(...(await drain(store, 'agentTasks', { where: { runId: run.id } })));
    background.push(...(await drain(store, 'backgroundTasks', { where: { runId: run.id } })));
  }
  const tasks = await hydrate(store, { declared, background, runs: runs.filter((run) => isWorkRun(run)) });
  const subtreeUsage: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0, costKnown: true, measured: true };
  for (const run of runs) addUsage(subtreeUsage, run.usage);
  if (origin === undefined) return null;
  const items = tasks.sort((a, b) => a.depth - b.depth || binary(a.startedAt, b.startedAt) || binary(a.id, b.id));
  return { rootRunId, origin, items, subtreeUsage };
}
