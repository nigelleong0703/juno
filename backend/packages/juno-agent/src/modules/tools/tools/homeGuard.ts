/**
 * What the file tools may do inside `/juno` (BACKEND §5.2, §5.7). files.write / files.edit write nothing there: MEMORY.md,
 * memory/**, people/**, groups/** and the rest of the home change only through the memory tools (memory_note, the daily-log
 * writer), the background jobs and the owner in the app. No file tool reads or writes another agent's `agents/<id>/` (§5.7): agents
 * meet through agent_directory and message_agent. In a run that is not owner-only (a group, a stranger, a platform chat the owner
 * did not wake) files.read and the searches also refuse the memory-owned paths and the home root, the same rule that keeps them out of
 * the prompt and memory_search. A shell can still get around all of this; a protected file is restored by the next sync.
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { ToolContext, ToolResult } from '../../../contracts/index.js';
import { evalReportsDir } from '../../evaluation/paths.js';
import { ALIGNMENT_FILE, HOME_ROOT, MEMORY_FILE, PROACTIVE_FILE, USER_FILE, relativeToHome } from '../../home/paths.js';
import { isSharedRun } from '../../profile/index.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import type { FileToolOptions } from './codingPath.js';

const REFUSAL = 'Files in /juno cannot be written with the file tools. Memory changes only through memory_note (your own notes) and the background jobs; proactive rules are recorded with preference_note. Everything else there is written by the user or the platform; ask the user to change it in the app.';

const FOREIGN = 'Another agent\'s files are not yours to read or change. To learn about or work with another agent, use agent_directory and message_agent.';

const PRIVATE = "Private memory isn't available in a chat with other people.";

const refusal = (path: string, text: string, code: string): ToolResult => ({ content: [{ type: 'text', text: 'Error: ' + text }], isError: true, details: { path, code } });

/** The home-relative path, '' for the home root or a directory above it (a search from there would reach everything), undefined outside the home. */
async function homeRelative(_opts: FileToolOptions, _ctx: ToolContext, path: string): Promise<string | undefined> {
  const resolved = path.startsWith('/') ? posix.normalize(path) : undefined;
  if (resolved !== undefined && (resolved === '/' || resolved === HOME_ROOT || resolved === HOME_ROOT + '/')) return '';
  return relativeToHome(path);
}

function isOtherAgentPath(rel: string, agentId: string): boolean {
  const match = /^agents(?:\/([^/]+))?(?:\/|$)/.exec(rel);
  return match !== null && match[1] !== agentId;
}

/** What the memory pipeline owns in the home and keeps private to the owner: the sheet, the logs, the people and group pages, what the jobs write. */
export const isMemoryOwnedPath = (rel: string): boolean =>
  rel === MEMORY_FILE || rel === USER_FILE || rel === ALIGNMENT_FILE || rel === PROACTIVE_FILE || /^(?:memory|people|groups|dreams|self_improvement|drafts)(?:\/|$)/.test(rel);

/**
 * An error result when `path` (resolved to an absolute path) may not be read or searched, else undefined: another agent's
 * `/juno/agents/<id>/` always; the memory-owned paths and the home root when anyone besides the owner is in the run.
 */
export async function refuseHomeRead(opts: FileToolOptions, ctx: ToolContext, path: string): Promise<ToolResult | undefined> {
  const rel = await homeRelative(opts, ctx, path);
  if (rel === undefined) return undefined;
  if (isOtherAgentPath(rel, ctx.agentId)) return refusal(path, FOREIGN, 'foreign_agent_path');
  return (rel === '' || isMemoryOwnedPath(rel)) && (await isSharedRun(ctx)) ? refusal(path, PRIVATE, 'private_memory') : undefined;
}

/** A person page's section heading for an agent: `## <name>（<agent id>）` (memory/views.ts). */
const AGENT_SECTION_HEADING = /^## .*（([^（）\n]+)）\s*$/;

/**
 * The text of a file for `agentId` to read. A person page (people/<id>.md) is shared by the owner's agents, but a `## <name>（<id>）`
 * section holds that agent's own lines (items with agent_id, BACKEND 5.7.4): the sections of the other agents, heading included, are
 * left out. Any other file is returned as it is.
 */
export function visibleFileText(path: string, content: string, agentId: string): string {
  const rel = relativeToHome(path);
  if (rel === undefined || !rel.startsWith('people/')) return content;
  let hidden = false;
  const kept: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      const section = AGENT_SECTION_HEADING.exec(line)?.[1];
      hidden = section !== undefined && section !== agentId;
    }
    if (!hidden) kept.push(line);
  }
  return kept.join('\n');
}

/** An error result when `path` (already resolved to an absolute path) may not be written, else undefined. */
export async function refuseProtectedHomePath(opts: FileToolOptions, ctx: ToolContext, _client: ComputerClient, path: string): Promise<ToolResult | undefined> {
  const rel = await homeRelative(opts, ctx, path);
  if (rel === undefined || rel === '') return undefined;
  if (isOtherAgentPath(rel, ctx.agentId)) return refusal(path, FOREIGN, 'foreign_agent_path');
  return refusal(path, REFUSAL, 'protected_path');
}

const SERVER_REPORTS = "Juno's evaluation reports are kept on the server, not on any computer, and cannot be read or changed by the agent.";

/**
 * An error result when `path` (already resolved to an absolute path, `~/` allowed) is the server's evaluation reports folder or inside it,
 * else undefined. Checked on every target, the Mac included: `on: 'mac'` skips the home rules, but a Mac is the owner's computer and on a
 * dev machine the server's disk is the same disk. A search rooted above the folder still walks into it; that is not refused here.
 */
export function refuseServerReports(path: string, env: Record<string, string | undefined> = process.env): ToolResult | undefined {
  const dir = posix.resolve(evalReportsDir(env));
  const absolute = path.startsWith('~/') ? posix.join(homedir(), path.slice(2)) : path;
  if (!absolute.startsWith('/')) return undefined;
  const resolved = posix.normalize(absolute);
  return resolved === dir || resolved.startsWith(dir + '/') ? refusal(path, SERVER_REPORTS, 'server_reports') : undefined;
}
