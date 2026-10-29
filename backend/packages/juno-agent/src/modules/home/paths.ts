/**
 * Where the agent's self-knowledge lives in the user's computer (BACKEND §5.1). Every path is relative to
 * `/juno`; the helpers here are pure so computerd, the sync and the file tools agree on the same rules.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** The home root in the sandbox: an absolute path, outside any user's `$HOME`. */
export const HOME_ROOT = '/juno';
export const HOME_DISPLAY = HOME_ROOT;
/** Marks a computer the mirror has been written to; without it the computer is new or reset (§5.2 rule 2). */
export const SYNC_MARKER = '.juno-sync';
export const USER_FILE = 'USER.md';
export const MEMORY_FILE = 'MEMORY.md';
/** Written by the learning job (BACKEND §5.6); read into the context when present. */
export const ALIGNMENT_FILE = 'ALIGNMENT_SYNTHESIS.md';
/** The owner's rules for what the agent may message about unprompted (BACKEND §5.10): a fixed format written only by code (modules/proactive), edited by the owner through /v1/proactive/rules. */
export const PROACTIVE_FILE = 'PROACTIVE_PREFERENCES.md';
/** The four files the user edits (per agent). */
export const AGENT_USER_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md'] as const;
export type AgentUserFile = (typeof AGENT_USER_FILES)[number];

const MAX_PATH_CHARS = 512;

export const homeHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

export const agentDir = (agentId: string): string => 'agents/' + agentId;
export const agentFilePath = (agentId: string, file: string): string => agentDir(agentId) + '/' + file;
export const skillPath = (agentId: string, slug: string): string => agentDir(agentId) + '/skills/' + slug + '/SKILL.md';

/** Stable, unique directory names for a list of skills: a slug of the name, `-2`, `-3`… for repeats. */
export function skillSlugs(skills: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const used = new Set<string>();
  const slugs = new Map<string, string>();
  for (const skill of skills) {
    const base = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = base + '-' + String(n);
    used.add(slug);
    slugs.set(skill.id, slug);
  }
  return slugs;
}

/** The agent a path belongs to, or undefined for the user's own files (USER.md, MEMORY.md, memory/, people/…). */
export function agentIdOfPath(path: string): string | undefined {
  const match = /^agents\/([^/]+)\//.exec(path);
  return match?.[1];
}

export const dailyLogPath = (date: string, agentId: string): string => 'memory/' + date + '/' + agentId + '.md';

/** `YYYY-MM-DD` of `now` on the user's wall clock (their IANA zone; UTC when unknown). */
export function localDate(now: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** `HH:MM` of `now` on the user's wall clock. */
export function localTime(now: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timeZone ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  } catch {
    return now.toISOString().slice(11, 16);
  }
}

/** `memory/YYYY-MM-DD/<agentId>.md`: each agent's daily log, the one file an agent adds to in the home, and only through memory_note (BACKEND §5.7). */
export const isDailyLog = (path: string): boolean => /^memory\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/.test(path);
export const isOwnDailyLog = (path: string, agentId: string): boolean => isDailyLog(path) && path.endsWith('/' + agentId + '.md');

/** The agent id a daily log belongs to (`memory/<date>/<agentId>.md`). */
export const dailyLogAgentId = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** The author tag a group note's lines end with, so a line keeps its writer when it is read or quoted away from its file. */
export const noteAuthorSuffix = (name: string, agentId: string): string => ` (noted by ${name.replace(/[()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'agent'}, ${agentId})`;

/** An agent id shortened for a prompt: `agt-1c0caec9-…` is shown as `agt-1c0c…`. */
export const shortAgentId = (agentId: string): string => (agentId.length > 8 ? agentId.slice(0, 8) + '…' : agentId);

/**
 * Everything in `/juno` except the daily logs is written only by the platform or the user (BACKEND §5.2); a change made any
 * other way is restored from the mirror. Which agent's log a tool may write is checked separately (`isOwnDailyLog`).
 */
export const isProtectedPath = (path: string): boolean => !isDailyLog(path);

/** What the user may write in the app (PUT/DELETE /v1/home): their own files, the curated memory, the drafts the ideas job prepared, and the creator's agent files. */
export function isUserWritablePath(path: string, ownedAgentIds: ReadonlySet<string>): boolean {
  if (path === USER_FILE || path === MEMORY_FILE || path.startsWith('memory/bank/') || path.startsWith('people/') || path.startsWith('groups/') || path.startsWith('drafts/')) return true;
  const match = /^agents\/([^/]+)\/([^/]+)$/.exec(path);
  return match !== null && ownedAgentIds.has(match[1] ?? '') && (AGENT_USER_FILES as readonly string[]).includes(match[2] ?? '');
}

/** null when `path` is a safe path relative to `/juno`, else why not. Symlink escapes are checked where the filesystem is. */
export function homePathError(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return 'path must be 1-' + String(MAX_PATH_CHARS) + ' characters';
  if (path.startsWith('/') || path.includes('\\') || [...path].some((char) => char.charCodeAt(0) < 32)) return 'path must be relative to /juno without control characters';
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'path must not contain empty, "." or ".." parts';
  return null;
}

/** The home-relative path of an absolute path inside `/juno`, or undefined when it points elsewhere. `..` is resolved first. */
export function relativeToHome(path: string): string | undefined {
  if (!path.startsWith('/')) return undefined;
  const resolved = posix.normalize(path);
  return resolved.startsWith(HOME_ROOT + '/') ? resolved.slice(HOME_ROOT.length + 1) : undefined;
}
