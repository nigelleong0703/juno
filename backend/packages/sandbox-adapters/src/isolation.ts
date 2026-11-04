/**
 * Hard isolation between agents on one computer (BACKEND §7.9), done at runtime by computerd as root, so no image
 * rebuild is needed. Three pieces:
 *  - `prepareComputer`: the one-time, idempotent migration of a computer (marker `/etc/juno/isolation-v1`): group,
 *    no sudo, /workspace and /juno ownership, screens booted the old way are stopped.
 *  - `prepareAgent` / `prepareScreen`: this agent's Linux user and private home, its Chromium profile moved in, its network
 *    namespace (`netns.ts`: separate loopback, guarded egress), `/proc` hidepid. Run every time a screen is (re)booted.
 *  - `agentRuntime`: wraps a ROOT runtime so every command and file call runs as the agent's user, inside its namespace.
 * `isolation-user.ts` has the pure naming, wrapper and ownership rules.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { createLogger } from '@agent-desktop/log';
import { MAX_INSTALL_PACKAGES, PACKAGE_NAME } from 'juno-agent/computer';
import { HOME_ROOT } from 'juno-agent/modules/home/paths';
import { failed } from './errors.js';
import {
  ISOLATION_MARKER,
  ISOLATION_TMP,
  NOT_READY_EXIT,
  NOT_READY_TEXT,
  SHARED_GROUP,
  agentCommand,
  agentHome,
  agentUser,
  agentUid,
  homeAgentOf,
  homeOwnership,
} from './isolation-user.js';
import { FIRST_SCREEN_DISPLAY, MAX_LIVE_SCREENS } from './ports.js';
import { SCRIPT_TIMEOUT_MS, runLocked } from './locked.js';
import { prepareNetns } from './netns.js';
import type { SandboxRuntime } from './runtime.js';
import { PROFILE_ROOT_FILE, homeProfile, legacyChromiumProfile, legacyStopScreenCommand, shq } from './screen-boot.js';

export { agentUser, agentHome, homeOwnership, homeAgentOf, ISOLATION_MARKER } from './isolation-user.js';
export { runLocked } from './locked.js';

const log = createLogger({ service: 'sandbox-isolation' });

/** Paths per chown/chmod command, so one line stays far below the argument-size limit. */
const PATHS_PER_COMMAND = 200;

const WORKSPACE = '/workspace';
const PROC_ROOT = '/tmp/vomu-proc';

const displays = (): number[] => Array.from({ length: MAX_LIVE_SCREENS }, (_, index) => FIRST_SCREEN_DISPLAY + index);

/** Everything that is done once per computer, before the marker exists. */
function migrationScript(): string {
  return [
    'set -e',
    'mkdir -p /etc/juno',
    `[ -f ${ISOLATION_MARKER} ] && { echo UNCHANGED; exit 0; }`,
    `getent group ${SHARED_GROUP} >/dev/null 2>&1 || groupadd ${SHARED_GROUP}`,
    // Screens booted the old way (Xvfb -ac, a shared profile) must restart; their pid files tell who to stop.
    ...displays().map(legacyStopScreenCommand),
    'rm -f /etc/sudoers.d/agent',
    'gpasswd -d agent sudo >/dev/null 2>&1 || true',
    `mkdir -p ${ISOLATION_TMP} ${PROC_ROOT}`,
    `chmod 0700 ${ISOLATION_TMP}`,
    // Sticky and write+search only: an agent can create its own scope directory but cannot list the others.
    `chmod 1733 ${PROC_ROOT}`,
    // /workspace stays the agents\' shared place (-n: do not recompute the ACL mask, so a rerun on durable files, BACKEND 7.10, changes no mode): group juno may read and write, new files inherit the group.
    `mkdir -p ${WORKSPACE}`,
    `chgrp -R ${SHARED_GROUP} ${WORKSPACE}`,
    `chmod -R g+rwX ${WORKSPACE}`,
    `chmod 2770 ${WORKSPACE}`,
    `find ${WORKSPACE} -type d -exec chmod g+s {} +`,
    `if command -v setfacl >/dev/null 2>&1; then setfacl -R -n -m g:${SHARED_GROUP}:rwX ${WORKSPACE}; setfacl -R -d -m g:${SHARED_GROUP}:rwX ${WORKSPACE}; fi`,
    `[ -e ${HOME_ROOT} ] || { [ -d /home/agent/juno ] && mv /home/agent/juno ${HOME_ROOT}; } || true`,
    `mkdir -p ${HOME_ROOT}`,
    'echo MIGRATING',
  ].join('\n');
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * Migrate a computer once (idempotent: the marker is written last). Returns true when it just did the work, which
 * also stopped every screen, so the caller must forget the screens it believed booted. `key` (the sandbox id)
 * makes concurrent callers share one run.
 */
export function prepareComputer(root: SandboxRuntime, key: string): Promise<boolean> {
  const running = inflight.get(key);
  if (running) return running;
  const work = (async () => {
    const out = await runLocked(root, migrationScript(), 'isolate the computer');
    if (!out.includes('MIGRATING')) return false;
    await applyHomeOwnership(root, '');
    await runLocked(root, `touch ${ISOLATION_MARKER}`, 'record the isolation marker');
    log.info({ key }, 'computer isolated: one Linux user per agent');
    return true;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

/** Shell that makes sure this agent's user, private home and Chromium profile exist (idempotent). */
export function userScript(agentId: string): string {
  const user = agentUser(agentId);
  const uid = agentUid(agentId);
  const home = agentHome(agentId);
  const homeProfileDir = homeProfile(agentId);
  const legacy = legacyChromiumProfile(agentId);
  return [
    `getent group ${SHARED_GROUP} >/dev/null 2>&1 || groupadd ${SHARED_GROUP}`,
    `id -u ${user} >/dev/null 2>&1 || { uidopt='-u ${uid}'; if getent passwd ${uid} >/dev/null 2>&1 || getent group ${uid} >/dev/null 2>&1; then uidopt=''; fi; useradd $uidopt -m -d ${home} -s /bin/bash -G ${SHARED_GROUP} ${user}; }`,
    `mkdir -p ${home}/.config`,
    // The look of the desktop (panel, window manager, wallpaper) comes from the template user's config; copy it once.
    `if [ ! -e ${home}/.config/xfce4 ] && [ -d /home/agent/.config/xfce4 ]; then for c in xfce4 devilspie2 autostart mimeapps.list; do [ -e /home/agent/.config/$c ] && cp -a /home/agent/.config/$c ${home}/.config/; done; fi`,
    // Logins survive: the profile lives on durable storage when the attach recorded one (BACKEND §7.11), else in the home. Either way
    // an older place is moved in once: the shared pre-isolation profile, and (durable only) the profile in the home.
    `PR=$(cat ${PROFILE_ROOT_FILE} 2>/dev/null || true)`,
    'if [ -n "$PR" ]; then',
    `  P="$PR/agents/${user}/chromium"`,
    // The root directories are traversable only; the agent's own directory is its private place.
    '  mkdir -p "$PR/agents" && chmod 0711 "$PR" "$PR/agents"',
    `  mkdir -p "$PR/agents/${user}" && chown ${user}:${user} "$PR/agents/${user}" && chmod 0700 "$PR/agents/${user}"`,
    '  if [ ! -e "$P" ]; then',
    `    for old in ${shq(homeProfileDir)} ${shq(legacy)}; do`,
    '      if [ -d "$old" ]; then cp -a "$old" "$P.moving" && mv "$P.moving" "$P" && rm -rf "$old"; break; fi',
    '    done',
    '  fi',
    '  mkdir -p "$P"',
    `  [ "$(stat -c %U "$P")" = ${user} ] || chown -R ${user}:${user} "$P"`,
    'else',
    `  P=${shq(homeProfileDir)}`,
    `  if [ -d ${shq(legacy)} ] && [ ! -e "$P" ]; then mv ${shq(legacy)} "$P"; fi`,
    '  mkdir -p "$P"',
    'fi',
    `chown -R ${user}:${user} ${home}`,
    `chmod 0700 ${home}`,
  ].join('\n');
}

/**
 * What a screen needs on top of the agent's user and namespace. Ports need no rule any more: an agent's Chromium debugging port is on
 * its namespace's loopback and the VNC ports are on root's, where no agent can connect (`netns.ts`).
 */
export function screenHardeningScript(): string {
  return [
    // Execute-only Chromium (BACKEND 8.7): a process whose binary its user cannot read is non-dumpable, so the agent's shell (the
    // browser's own Linux user) cannot ptrace it or read its memory. The image bakes this in; older computers get it here
    // (it applies to the next Chromium start).
    'chmod 0711 /usr/lib/chromium/chromium 2>/dev/null || true',
    // Other users' processes and command lines vanish from /proc. Needs SYS_ADMIN: skipped (and said so) where not allowed.
    'if grep -qE " /proc proc .*hidepid=(2|invisible)" /proc/mounts; then :; elif mount -o remount,hidepid=2 /proc 2>/dev/null; then echo "isolation: /proc remounted hidepid=2"; else echo "isolation: could not remount /proc with hidepid=2 (needs SYS_ADMIN); skipped"; fi',
  ].join('\n');
}

/** Make sure this agent's user, network namespace and home exist and its identity directory is private to it. */
export async function prepareAgent(root: SandboxRuntime, agentId: string): Promise<void> {
  await runLocked(root, userScript(agentId), `create the user for agent ${agentId}`);
  await prepareNetns(root, agentId);
  await applyHomeOwnership(root, `agents/${agentId}`);
}

/** The computer is migrated and this agent has its user: what any agent command needs. True when the migration just ran. */
export async function prepareForAgent(root: SandboxRuntime, key: string, agentId: string): Promise<boolean> {
  const migrated = await prepareComputer(root, key);
  await prepareAgent(root, agentId);
  return migrated;
}

/**
 * Everything a screen needs before it boots: the computer is migrated, the agent has its user and namespace, and `/proc` is hidden.
 * Returns true when the migration just ran (the caller drops its booted-screens cache).
 */
export async function prepareScreen(root: SandboxRuntime, key: string, agentId: string, displayNo: number): Promise<boolean> {
  const migrated = await prepareForAgent(root, key, agentId);
  const out = await runLocked(root, screenHardeningScript(), `harden the computer for screen :${displayNo}`);
  for (const line of out.split('\n')) if (line.startsWith('isolation:')) log.info({ displayNo }, line);
  return migrated;
}

/**
 * Set owner, group and mode of everything under `<JUNO_HOME>/<sub>` from `homeOwnership` (the whole home when `sub`
 * is empty). The agent users involved are created first. Symlinks are left alone.
 */
export async function applyHomeOwnership(root: SandboxRuntime, sub: string): Promise<void> {
  const start = sub === '' ? '.' : './' + sub;
  const listed = await root.run(`cd ${HOME_ROOT} 2>/dev/null && [ -e ${shq(start)} ] && find ${shq(start)} -printf '%y\\t%p\\n'; true`, { timeoutMs: SCRIPT_TIMEOUT_MS });
  if (listed.exitCode !== 0) throw failed(`could not list ${HOME_ROOT}: ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`);
  const groups = new Map<string, string[]>();
  const agents = new Set<string>();
  for (const line of listed.stdout.split('\n')) {
    const [type, raw] = line.split('\t');
    if ((type !== 'd' && type !== 'f') || raw === undefined) continue;
    const path = raw === '.' ? '' : raw.replace(/^\.\//, '');
    if ([...path].some((char) => char.charCodeAt(0) < 32)) continue;
    const { owner, group, mode } = homeOwnership(path, type === 'd');
    const key = `${owner}:${group}\t${mode}`;
    groups.set(key, [...(groups.get(key) ?? []), path === '' ? '.' : path]);
    const agent = homeAgentOf(path);
    if (agent !== undefined) agents.add(agent);
  }
  if (groups.size === 0) return;
  const lines = ['set -e', ...[...agents].map(userScript), `cd ${HOME_ROOT}`];
  for (const [key, paths] of groups) {
    const [ownerGroup = '', mode = ''] = key.split('\t');
    for (let at = 0; at < paths.length; at += PATHS_PER_COMMAND) {
      const chunk = paths.slice(at, at + PATHS_PER_COMMAND).map(shq).join(' ');
      lines.push(`chown -h ${ownerGroup} -- ${chunk}`, `chmod ${mode} -- ${chunk}`);
    }
  }
  const file = `${ISOLATION_TMP}/own-${randomUUID()}.sh`;
  await root.writeText(file, lines.join('\n') + '\n');
  try {
    await runLocked(root, `sh ${shq(file)}`, 'set file ownership under /juno');
  } finally {
    await root.run(`rm -f ${shq(file)}`, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

/**
 * Ownership for ONE path just written (the file and every directory above it up to the home). The home writes call
 * this so a new file or directory never stays root:root 0755.
 */
export function ownershipScript(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  const lines = [`cd ${HOME_ROOT}`];
  const targets: Array<{ rel: string; dir: boolean }> = [{ rel: '.', dir: true }];
  parts.forEach((_, index) => targets.push({ rel: parts.slice(0, index + 1).join('/'), dir: index < parts.length - 1 }));
  for (const { rel, dir } of targets) {
    const { owner, group, mode } = homeOwnership(rel === '.' ? '' : rel, dir);
    lines.push(`chown -h ${owner}:${group} -- ${shq(rel)} && chmod ${mode} -- ${shq(rel)}`);
  }
  return lines.join('\n');
}

/**
 * A runtime that runs everything as the agent's Linux user, on top of a ROOT runtime of the same computer.
 * Only when the wrapper reports the computer is not isolated yet (which cannot have run the command) is it
 * prepared (`key` is the sandbox id) and the command retried once.
 */
export function agentRuntime(root: SandboxRuntime, key: string, agentId: string): SandboxRuntime {
  /** Run an `agentCommand` (possibly with a redirection appended); prepare and retry once if it reports "not isolated yet". */
  async function runWrapped(wrapped: string, options: Parameters<SandboxRuntime['run']>[1] = {}) {
    const withCwd = { ...options, cwd: options.cwd ?? WORKSPACE };
    const first = await root.run(wrapped, withCwd);
    if (first.exitCode !== NOT_READY_EXIT || !first.stderr.includes(NOT_READY_TEXT)) return first;
    await prepareForAgent(root, key, agentId);
    return root.run(wrapped, withCwd);
  }
  const run: SandboxRuntime['run'] = (command, options) => runWrapped(agentCommand(agentId, command), options);

  return {
    run,
    async readText(path) {
      const result = await run(`cat -- ${shq(path)}`, { timeoutMs: 60_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cat exited ${result.exitCode}`);
      return result.stdout;
    },
    // Platform-initiated reads of the agent's own scratch files (screenshots, process output slices).
    readBytes: (path) => root.readBytes(path),
    writeText: (path, content) => writeAsAgent(path, Buffer.from(content, 'utf8')),
    writeBytes: (path, content) => writeAsAgent(path, content),
  };

  async function writeAsAgent(path: string, content: Uint8Array): Promise<void> {
    // The content goes through a root-only file, opened by the root shell and handed to the agent's command as stdin,
    // so it never sits in a command line or a file the agents can read.
    const tmp = `${ISOLATION_TMP}/w-${randomUUID()}`;
    await root.writeBytes(tmp, content);
    try {
      const inner = `mkdir -p -- ${shq(posix.dirname(path))} && cat > ${shq(path)}`;
      const result = await runWrapped(`${agentCommand(agentId, inner)} < ${shq(tmp)}`, { timeoutMs: 60_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `write exited ${result.exitCode}`);
    } finally {
      await root.run(`rm -f ${shq(tmp)}`, { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }
}

export function validatePackages(packages: readonly string[]): string[] {
  if (packages.length === 0 || packages.length > MAX_INSTALL_PACKAGES) throw failed(`name between 1 and ${MAX_INSTALL_PACKAGES} packages`);
  for (const name of packages) {
    if (!PACKAGE_NAME.test(name)) throw failed(`"${name}" is not a valid package name (lower-case letters, digits, + . -)`);
  }
  return [...packages];
}

/** apt-get as root (the only way an agent installs system software); the tail of its output is the result. */
export async function installPackages(root: SandboxRuntime, packages: readonly string[]): Promise<string> {
  const names = validatePackages(packages);
  const program = [
    'set -o pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq 2>&1 | tail -n 5',
    `apt-get install -y --no-install-recommends -- ${names.join(' ')} 2>&1 | tail -n 40`,
  ].join('\n');
  const result = await root.run(`/bin/bash -c ${shq(program)}`, { timeoutMs: 600_000 });
  const text = (result.stdout + result.stderr).trim().slice(-4_000);
  if (result.exitCode !== 0) throw failed(`apt-get could not install ${names.join(', ')}: ${text}`);
  return text;
}
