/**
 * Per-agent Linux users (BACKEND §7.9): the pure parts. Every agent action runs as `juno-<short id>` with no sudo;
 * the platform (computerd) runs as root. This module has the user names, the wrapper that drops a root command to an
 * agent user, and the owner/group/mode of every path under `/juno`, in one place so the home writes, the migration
 * and the daily-log batch all agree.
 */
import { createHash } from 'node:crypto';
import { shq } from './shq.js';

/** Written last by the one-time migration; its presence is the fast path of every agent command. */
export const ISOLATION_MARKER = '/etc/juno/isolation-v1';
/** Root-only scratch for file contents on their way into an agent-owned file. */
export const ISOLATION_TMP = '/etc/juno/tmp';
/** Exit status and stderr marker of a command that was NOT run because the computer is not isolated yet. */
export const NOT_READY_EXIT = 97;
export const NOT_READY_TEXT = 'JUNO_ISOLATION_NOT_READY';

/** The shared group every agent user belongs to (reads the shared user layer, shares /workspace). */
export const SHARED_GROUP = 'juno';

/** `juno-` plus 12 hex digits of the agent id's hash: fixed length (Linux names are at most 32), no collisions from slugging. */
export const agentUser = (agentId: string) => 'juno-' + createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 12);
/**
 * A fixed uid per agent (20000-59999 from the same hash), so files on durable storage (BACKEND 7.10) keep their owner when a
 * new computer is built for the same user. `userScript` falls back to a free uid when a computer already uses this one.
 */
export const agentUid = (agentId: string) => 20000 + (Number.parseInt(createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 8), 16) % 40000);
export const agentHome = (agentId: string) => '/home/' + agentUser(agentId);
/** The per-agent X cookie file (the Xvfb `-auth` file and the clients' `XAUTHORITY`). */
export const agentXauthority = (agentId: string) => agentHome(agentId) + '/.Xauthority';

/**
 * `command` (a full POSIX shell program) as the agent's user. Meant to run as root. When the computer has not been
 * isolated yet (or the user does not exist) it prints the marker and exits `NOT_READY_EXIT` WITHOUT running the
 * command, so the caller can prepare and retry once without ever running a command twice.
 * `setpriv` execs (no extra process between the runtime's timeout/kill handling and the command); `umask 002` makes
 * what an agent creates group-writable, so the other agents can use files in the shared /workspace.
 */
export function agentCommand(agentId: string, command: string): string {
  const user = agentUser(agentId);
  const home = agentHome(agentId);
  const env = [
    `HOME=${home}`,
    `USER=${user}`,
    `LOGNAME=${user}`,
    `XAUTHORITY=${agentXauthority(agentId)}`,
    `NPM_CONFIG_PREFIX=${home}/.npm-global`,
    `PATH=${home}/.local/bin:${home}/.npm-global/bin:$PATH`,
  ].join(' ');
  return [
    `[ -f ${ISOLATION_MARKER} ] && [ -d ${shq(home)} ] || { echo ${NOT_READY_TEXT} >&2; exit ${NOT_READY_EXIT}; }`,
    `exec setpriv --reuid=${user} --regid=${user} --init-groups env ${env} /bin/sh -c ${shq('umask 002\n' + command)}`,
  ].join('\n');
}

export interface Ownership {
  owner: string;
  group: string;
  /** Octal, e.g. `0640`. */
  mode: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Who owns `<JUNO_HOME>/<path>` and with what mode (the §7.9 table). `path` is relative to the home ('' is the home
 * itself). The one function the home writes, the migration and the daily-log pre-creation use.
 *  - `dreams/`, `self_improvement/`: platform only.
 *  - `agents/<id>/…`: readable by that agent only (group `juno-<id>`); platform writes.
 *  - `memory/<day>/<agentId>.md`: owned by that agent, readable by all agents.
 *  - everything else (the shared user layer): readable by all agents, written by the platform only.
 */
export function homeOwnership(path: string, isDir: boolean): Ownership {
  const [top, second, third, ...rest] = path.split('/').filter((part) => part !== '');
  if (top === 'dreams' || top === 'self_improvement') return { owner: 'root', group: 'root', mode: isDir ? '0700' : '0600' };
  if (top === 'agents') {
    // `agents/` itself is only traversable: an agent can reach its own directory but cannot list the others.
    if (second === undefined) return { owner: 'root', group: 'root', mode: '0711' };
    return { owner: 'root', group: agentUser(second), mode: isDir ? '0750' : '0640' };
  }
  if (top === 'memory' && second !== undefined && DAY.test(second) && third !== undefined && third.endsWith('.md') && third.length > 3 && rest.length === 0 && !isDir) {
    return { owner: agentUser(third.slice(0, -3)), group: SHARED_GROUP, mode: '0640' };
  }
  return { owner: 'root', group: SHARED_GROUP, mode: isDir ? '0750' : '0640' };
}

/** The agent id a path is private to (`agents/<id>/…` or a `memory/<day>/<id>.md` log), when it has one. */
export function homeAgentOf(path: string): string | undefined {
  const [top, second, third, ...rest] = path.split('/').filter((part) => part !== '');
  if (top === 'agents') return second;
  if (top === 'memory' && second !== undefined && DAY.test(second) && third !== undefined && third.endsWith('.md') && third.length > 3 && rest.length === 0) return third.slice(0, -3);
  return undefined;
}

