/**
 * Runs the home sync and the UI writes (BACKEND §5.2, §5.4). The mirror rows are what the context reads; a sync makes them
 * equal to the computer (or the computer equal to them, for protected files) first. Nothing here depends on Restate: a
 * context build calls `loadHomeView` inside its journaled step, so a replay reads the log and never reaches the computer.
 */
import type { Store } from '../../contracts/index.js';
import { runWithOwner } from '../../owner-context.js';
import { auditInitiatorFor } from '../../execution/harness/logic/run-origin.js';
import type { AgentHomeRow } from '../../contracts/storage.js';
import type { HomeComputer, HomeSnapshot, PlatformSkill } from '../../ports/computer/index.js';
import { joinAgentsFile, renderHomeView, type HomeView } from './render.js';
import { deleteRow, getRow, newRow, putRow, readRows, rowId } from './mirror.js';
import { SYNC_MARKER, agentFilePath, agentIdOfPath, agentDir, dailyLogPath, homeHash, isOwnDailyLog, localDate } from './paths.js';
import { appendedText, planSync } from './sync.js';
import { skillFiles } from './skills.js';
import { platformDocs } from './docs.js';
import type { SkillsService } from '@agent-desktop/memory-graph/skills';

export interface HomeDeps {
  store: Store;
  /** Absent when no computer is configured: the mirror alone feeds the context. */
  home?: HomeComputer;
  /** The versioned skill store (Postgres); absent, and then no skill files are projected. */
  skills?: SkillsService;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

const nowIso = (): string => new Date().toISOString();

/** The caller's version of a file is stale (409 `HOME_CONFLICT`). */
export class HomeConflictError extends Error {
  constructor(readonly path: string) {
    super(path + ' changed since it was read; reload and retry');
  }
}

/** The computer could not be reached for an operation that cannot wait (503). */
export class HomeUnavailableError extends Error {}

/** The wire code of a computer error, whichever client class carried it. */
const errorCode = (error: unknown): unknown => (typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined);

async function emitChanged(store: Store, ownerId: string, path: string): Promise<void> {
  const agentId = agentIdOfPath(path);
  await store.emit({ type: 'agent.home.changed', ownerId, path, ...(agentId === undefined ? {} : { agentId }) });
}

/** Refresh the rows only the platform writes (the docs and this agent's skills); report which changed or went away. */
async function refreshPlatformRows(deps: HomeDeps, ownerId: string, agentId: string, rows: Map<string, AgentHomeRow>) {
  const store = deps.store;
  const desired = await skillFiles({ store, ownerId, ...(deps.skills === undefined ? {} : { skills: deps.skills }) }, agentId);
  const updated = new Set<string>();
  const removed = new Set<string>();
  for (const [path, content] of [...platformDocs(), ...desired]) {
    if (rows.get(path)?.hash === homeHash(content)) continue;
    const row = await putRow(store, newRow(ownerId, path, content, 'platform', nowIso()));
    rows.set(path, row);
    updated.add(path);
  }
  const skills = agentDir(agentId) + '/skills/';
  for (const path of [...rows.keys()]) {
    if (!path.startsWith(skills) || desired.has(path)) continue;
    await deleteRow(store, ownerId, path);
    rows.delete(path);
    removed.add(path);
  }
  return { updated, removed };
}

/** Lines an agent wrote for a teammate that must go to the teammate's mirror instead of the creator's. */
interface Diverted {
  path: string;
  text: string;
}

interface SyncOptions {
  /** Today's log of the agent: created when missing so the agent can append to it. */
  dailyLog: string;
  /** The agent runs for someone else (a teammate): daily-log lines it wrote are handed back instead of kept (§5.7.1). */
  divert: boolean;
}

interface SyncResult {
  diverted: Diverted[];
  /** The platform skills the snapshot listed (read-only in the image; not mirrored). */
  platformSkills: PlatformSkill[];
}

/** Run the sync rules against a fresh snapshot, mutating `rows` to the final mirror. Throws when the computer fails. */
async function syncRows(deps: HomeDeps & { home: HomeComputer }, ownerId: string, agentId: string, rows: Map<string, AgentHomeRow>, signal: AbortSignal, options: SyncOptions): Promise<SyncResult> {
  const { store, home } = deps;
  const platform = await refreshPlatformRows(deps, ownerId, agentId, rows);
  const snapshot: HomeSnapshot = await home.snapshot(agentId, signal);
  const plan = planSync({ snapshot, rows, platformUpdated: platform.updated, platformRemoved: platform.removed });
  const mtimes = new Map(snapshot.files.map((file) => [file.path, file.mtime]));

  for (const path of plan.remove) await home.delete(agentId, path, undefined, signal);
  for (const path of plan.write) {
    const row = rows.get(path);
    if (row !== undefined) await home.write(agentId, path, row.content, undefined, signal);
  }
  if (plan.marker) await home.write(agentId, SYNC_MARKER, nowIso(), undefined, signal);
  for (const path of plan.clearPending) {
    const row = rows.get(path);
    if (row === undefined) continue;
    const { pendingWrite: _pending, ...cleared } = row;
    rows.set(path, await putRow(store, cleared));
  }
  const diverted: Diverted[] = [];
  for (const path of plan.pull) {
    const file = await home.read(agentId, path, signal);
    if (file === null) continue;
    if (options.divert && isOwnDailyLog(path, agentId)) {
      // The creator's computer is only the place the agent can write; whatever it appended belongs to the person it worked for.
      const base = rows.get(path)?.content ?? '';
      const text = appendedText(base, file.content);
      if (text.trim().length > 0) diverted.push({ path, text });
      if (file.content !== base) await home.write(agentId, path, base, undefined, signal);
      if (!rows.has(path)) rows.set(path, await putRow(store, newRow(ownerId, path, base, 'platform', nowIso())));
      continue;
    }
    const updatedAt = new Date((mtimes.get(path) ?? Date.now() / 1000) * 1000).toISOString();
    rows.set(path, await putRow(store, newRow(ownerId, path, file.content, 'agent', updatedAt)));
    await emitChanged(store, ownerId, path);
  }
  for (const path of plan.dropRows) {
    await deleteRow(store, ownerId, path);
    rows.delete(path);
    await emitChanged(store, ownerId, path);
  }
  for (const entry of plan.reverted) {
    await store.put('audit', {
      ...auditInitiatorFor(null),
      id: 'audit-home-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8), at: nowIso(), actor: 'system', agentId,
      action: 'agent_home.reverted', target: entry.path, decision: 'denied',
      reason: 'protected file changed outside the platform (before ' + (entry.before?.slice(0, 12) ?? 'missing') + ', restored ' + (entry.after?.slice(0, 12) ?? 'removed') + ')',
    }, { agentId, kind: 'agent_home.reverted' });
  }
  // Today's log must exist for the agent to append to; the empty mirror row keeps the next sync from pulling it again.
  const present = snapshot.files.some((file) => file.path === options.dailyLog) || plan.write.includes(options.dailyLog);
  if (!present) {
    await home.ensure(agentId, options.dailyLog, signal);
    if (!rows.has(options.dailyLog)) rows.set(options.dailyLog, await putRow(store, newRow(ownerId, options.dailyLog, '', 'platform', nowIso())));
  }
  return { diverted, platformSkills: snapshot.platformSkills ?? [] };
}

/** Append lines an agent wrote for this user to their daily-log row; it reaches their computer as a pending write on their next sync. */
async function keepDiverted(store: Store, ownerId: string, entries: Diverted[]): Promise<void> {
  for (const { path, text } of entries) {
    const existing = (await getRow(store, ownerId, path))?.content ?? '';
    const joined = existing.length === 0 || existing.endsWith('\n') ? existing + text : existing + '\n' + text;
    await putRow(store, newRow(ownerId, path, joined.endsWith('\n') ? joined : joined + '\n', 'agent', nowIso(), true));
    await emitChanged(store, ownerId, path);
  }
}

/**
 * The agent's home as the context needs it. With `sync` the computer is consulted first (§5.3: once per run, then only after
 * file-changing tools); without, or when the computer cannot be reached, the mirror is used as it stands, so the agent keeps
 * its identity and the run goes on.
 */
export async function loadHomeView(
  deps: HomeDeps,
  input: { ownerId: string; agentOwnerId?: string; agentId: string; seq: number; sync: boolean; timeZone?: string; now?: Date; signal?: AbortSignal },
): Promise<HomeView> {
  const { store, home } = deps;
  // The identity layer is the agent creator's; the user layer is the talker's (BACKEND §5.7). They are the same person unless a
  // teammate talks to a team-published agent: then the creator's computer is synced and the talker's mirror is only read.
  const creator = input.agentOwnerId ?? input.ownerId;
  const inScope = <T>(fn: () => Promise<T>): Promise<T> => (creator === input.ownerId ? fn() : runWithOwner(creator, fn));
  const rows = await inScope(() => readRows(store, creator, input.agentId));
  // The daily log is named by the date on the talker's clock, and exists only when the computer could be reached.
  const today = localDate(input.now ?? new Date(), input.timeZone);
  const dailyLog = dailyLogPath(today, input.agentId);
  let reachable = false;
  let platformSkills: PlatformSkill[] = [];
  if (home !== undefined && input.sync) {
    try {
      const options = { dailyLog, divert: creator !== input.ownerId };
      const synced = await inScope(() => syncRows({ ...deps, home }, creator, input.agentId, rows, input.signal ?? AbortSignal.timeout(60_000), options));
      await keepDiverted(store, input.ownerId, synced.diverted);
      platformSkills = synced.platformSkills;
      reachable = true;
    } catch (error) {
      deps.log?.({ agentId: input.agentId, error: error instanceof Error ? error.message : String(error) }, 'home sync skipped: computer unavailable');
    }
  }
  if (creator !== input.ownerId) {
    const talker = await readRows(store, input.ownerId, input.agentId);
    for (const path of [...rows.keys()]) if (!path.startsWith('agents/')) rows.delete(path);
    for (const [path, row] of talker) if (!path.startsWith('agents/')) rows.set(path, row);
  }
  return renderHomeView(rows, input.agentId, input.seq, reachable ? dailyLog : '', platformSkills);
}

/**
 * A write from the app (BACKEND §5.2): the computer first, then the mirror. `expectedHash` is checked against both; a
 * stale one is a conflict. When the computer cannot be reached the mirror row is saved pending and lands on the next sync.
 */
export async function writeHomeFile(
  deps: HomeDeps,
  input: { ownerId: string; agentId?: string; path: string; content: string; expectedHash?: string; writer: AgentHomeRow['writer']; signal?: AbortSignal },
): Promise<AgentHomeRow> {
  const { store, home } = deps;
  const existing = await getRow(store, input.ownerId, input.path);
  if (input.expectedHash !== undefined && (existing?.hash ?? '') !== input.expectedHash) throw new HomeConflictError(input.path);
  let pendingWrite = true;
  if (home !== undefined) {
    try {
      await home.write(input.agentId, input.path, input.content, input.expectedHash, input.signal ?? AbortSignal.timeout(30_000));
      pendingWrite = false;
    } catch (error) {
      if (errorCode(error) === 'home_conflict') throw new HomeConflictError(input.path);
      deps.log?.({ path: input.path, error: error instanceof Error ? error.message : String(error) }, 'home write saved to the mirror only: computer unavailable');
    }
  }
  const row = await putRow(store, newRow(input.ownerId, input.path, input.content, input.writer, nowIso(), pendingWrite));
  await emitChanged(store, input.ownerId, input.path);
  return row;
}

/** Delete a file the user removed in the app: it must go from the computer too, so an unreachable computer is an error. */
export async function deleteHomeFile(deps: HomeDeps, input: { ownerId: string; agentId?: string; path: string; signal?: AbortSignal }): Promise<boolean> {
  const { store, home } = deps;
  const existing = await getRow(store, input.ownerId, input.path);
  if (existing === null) return false;
  if (home !== undefined) {
    try {
      await home.delete(input.agentId, input.path, undefined, input.signal ?? AbortSignal.timeout(30_000));
    } catch (error) {
      throw new HomeUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }
  await store.delete('agentHome', rowId(input.ownerId, input.path));
  await emitChanged(store, input.ownerId, input.path);
  return true;
}

/** The initial texts of a new agent (or one migrated from the old fields), as pending mirror rows that reach the computer on the next sync. */
export async function seedAgentFiles(
  store: Store,
  ownerId: string,
  agentId: string,
  texts: { personality?: string; principles?: string; instructions?: string; toolNotes?: string; proactivePreferences?: string },
): Promise<string[]> {
  const files: Array<[string, string]> = [
    [agentFilePath(agentId, 'IDENTITY.md'), texts.personality ?? ''],
    [agentFilePath(agentId, 'SOUL.md'), texts.principles ?? ''],
    [agentFilePath(agentId, 'AGENTS.md'), joinAgentsFile(texts.instructions ?? '', texts.proactivePreferences ?? '')],
    [agentFilePath(agentId, 'TOOLS.md'), texts.toolNotes ?? ''],
  ];
  const written: string[] = [];
  for (const [path, content] of files) {
    if (content.trim().length === 0) continue;
    await putRow(store, newRow(ownerId, path, content, 'user', nowIso(), true));
    written.push(path);
  }
  return written;
}
