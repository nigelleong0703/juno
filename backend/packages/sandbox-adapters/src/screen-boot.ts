/**
 * The shell program that boots one agent display inside the shared VM, the pure command builders,
 * and the boot outcome: the live handle it reports and the safe operator error when it fails.
 *
 * Process management is by PID FILE, never \`pgrep -f\`: the script text itself contains the plain
 * launch commands (\`Xvfb :1 …\`), so \`pgrep -f 'Xvfb :1 '\` matches the shell running the script and
 * silently skips the start. Each service records its pid and is "running" only when \`kill -0\`
 * agrees; stopping kills the recorded pids (plus children) rather than pattern-matching.
 *
 * Chromium runs with \`--no-sandbox\` (the sandbox user is root) and the Home start page, then the
 * script WAITS for its window before reporting ready — a pid is not enough, and an unrendered
 * Chromium would show as a black screenshot. Readiness is never the start page's TITLE: a user or
 * agent navigates the browser away, so the title changes while the window, profile and CDP stay
 * healthy. The check instead ties the window on this display to the exact Chromium pid we launched
 * and requires its CDP endpoint, so a navigated browser is reused, never killed and re-launched. If
 * neither appears the script prints the Chromium log and fails.
 */
import type { SandboxRuntime } from './runtime.js';
import { parseResolution } from './types.js';
import type { ScreenHandle, ScreenRequest } from './types.js';
import { ComputerdError, failed } from './errors.js';
import { screenPorts } from './ports.js';
import { screenStartFailure } from './screen-diagnostics.js';
import { agentHome, agentUser } from './isolation-user.js';
import { shq } from './shq.js';

// Re-exported unchanged so this module keeps its public surface (the package index, the action
// runner, the file reader and the tests all import these from here).
export { imageInfo, pngSize, screenStartFailure, xdotoolClick, xdotoolMove, xdotoolScroll } from './screen-diagnostics.js';

export { shq };

/** A filesystem/process-safe agent identifier. */
export const agentSlug = (agentId: string) => agentId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);

/**
 * Where the platform tells a computer that agent browser profiles live on durable storage (BACKEND §7.11): the storage
 * attach writes the root of that directory here. Absent (no durable storage), a profile stays in the agent's home.
 */
export const PROFILE_ROOT_FILE = '/etc/juno/profile-root';

/** The profile's parent directory on durable storage: `<root>/agents/<juno-user>/chromium`, owned by the agent, 0700. */
export const durableProfile = (profileRoot: string, agentId: string) => `${profileRoot}/agents/${agentUser(agentId)}/chromium`;

/** The profile the computer used before durable storage (and still does without it), in the agent's private home. */
export const homeProfile = (agentId: string) => `${agentHome(agentId)}/.config/chromium`;

/**
 * The one Chromium profile for an agent, as a double-quoted shell word resolved INSIDE the computer: durable storage when the
 * attach recorded one, else the agent's home. `SCREEN_HOME` is the unit-test seam (it forces the home layout). Every caller
 * builds the path with this.
 */
export const chromiumProfileExpr = (agentId: string) =>
  `"$(r=$(cat ${PROFILE_ROOT_FILE} 2>/dev/null || true); if [ -z "\${SCREEN_HOME:-}" ] && [ -n "$r" ]; then echo "$r/agents/${agentUser(agentId)}/chromium"; else echo "\${SCREEN_HOME:-${agentHome(agentId)}}/.config/chromium"; fi)"`;

/** Where an agent's profile lived before per-agent users (all agents shared `/home/agent`); the migration moves it. */
export const legacyChromiumProfile = (agentId: string) => `/home/agent/.config/chromium-${agentSlug(agentId)}`;

const profileExpr = chromiumProfileExpr;

/**
 * Flags the prototype proved out on this VM: root needs \`--no-sandbox\`, and \`about:blank\` renders black.
 * \`--deny-permission-prompts\` answers every site permission request (notifications, location, camera, mic…)
 * with "deny" instead of a bubble the agent cannot see; the managed policies (sandbox-image
 * files/chromium-policies.json) block the same and keep password/translate/sign-in/default-browser prompts away.
 */
export const chromiumFlags =
  '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --no-first-run --start-maximized --disable-background-networking --disable-extensions --force-renderer-accessibility --hide-crash-restore-bubble --deny-permission-prompts';

/** The static Home page shipped in the image (see sandbox-image/files/agent-home). */
export const startPageUrl = 'file:///usr/local/share/agent-home/index.html';

/** Where the per-service pid files and logs live (also the unit-test seam). */
export const pidDir = (displayNo: number) => `/tmp/agent-screen-${displayNo}`;

/**
 * Where the pid files and logs of the services ROOT starts (Xvfb, x11vnc, noVNC) live: a root-only directory. The
 * agent owns `pidDir` (its dock and watchdog write there), so a pid file in it is the agent's word, never root's.
 */
export const rootDir = (displayNo: number) => `/run/juno/screen-${displayNo}`;

/** Services root starts; every other service of a display runs as the agent. */
const ROOT_SERVICES = 'xvfb|vnc|vncview|novnc|novncview';

/**
 * Kill functions for root-run programs. `kill_root` trusts only files in the root-only directory. `kill_agent` acts
 * on a pid from an agent-writable file only when that process really belongs to the agent's uid (and its children
 * are matched with `-U` as well), so a forged pid can never make root kill another agent's or the platform's process.
 */
const killHelpers = (uid: string): string[] => [
  'kill_root() { p=$(pf "$1"); if [ -f "$p" ]; then pkill -P "$(cat "$p")" 2>/dev/null || true; kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi; }',
  `kill_agent() { p=$(pf "$1"); if [ -f "$p" ]; then q=$(cat "$p" 2>/dev/null); case "$q" in ''|*[!0-9]*) ;; *) if [ "$(ps -o uid= -p "$q" 2>/dev/null | tr -d " ")" = "${uid}" ]; then pkill -U "${uid}" -P "$q" 2>/dev/null || true; kill "$q" 2>/dev/null || true; fi;; esac; rm -f "$p"; fi; }`,
];

/** A command run on a display, in the timezone its boot recorded (UTC before any boot). */
export const displayShell = (displayNo: number, command: string) =>
  `export TZ="$(cat ${shq(pidDir(displayNo) + '/tz')} 2>/dev/null || echo UTC)"\n${command}`;

/** What a display boots with: exactly the provider's screen request, so a new field reaches the boot. */
export type ScreenBootRequest = ScreenRequest;

/** The pid-file helpers every per-display program starts with (shared by the boot and the watchdog commands). */
const pidHelpers = (d: number): string[] => [
  `pf() { echo "${pidDir(d)}/$1.pid"; }`,
  'alive() { [ -f "$(pf "$1")" ] && kill -0 "$(cat "$(pf "$1")")" 2>/dev/null; }',
  'start_bg() { name=$1; shift; "$@" >>"$(dirname "$(pf "$name")")/$name.log" 2>&1 & echo $! > "$(pf "$name")"; }',
];

/**
 * A Chromium that still owns the profile (its SingletonLock names `<host>-<pid>`) is that display's browser even
 * when chromium.pid is stale: a second launch would only hand off to it and exit, so boot would wait for a
 * window its recorded pid never owns. Record the lock holder's pid instead of launching again.
 */
/**
 * Profiles live on durable storage and outlive computers, so a profile can still carry the SingletonLock of a computer that
 * is gone (`<other host>-<pid>`); Chromium then refuses to start ("in use by another Chromium process on another computer").
 * One computer per owner at a time, so a lock naming another host is always stale: drop it. A lock of this host is left alone.
 */
const dropForeignLock = (profile: string): string =>
  `lock=$(readlink ${profile}/SingletonLock 2>/dev/null || true); ` +
  `if [ -n "$lock" ] && [ "\${lock%-*}" != "$(hostname)" ]; then rm -f ${profile}/SingletonLock ${profile}/SingletonSocket ${profile}/SingletonCookie; fi`;

const adoptChromium = (profile: string, pidFile: string, uid: string): string =>
  `lock=$(readlink ${profile}/SingletonLock 2>/dev/null || true); lp=\${lock##*-}; ` +
  // Only a process of this agent's own uid can be the browser (the lock is a symlink the agent controls).
  `if [ -n "$lp" ] && [ "\${lock%-*}" = "$(hostname)" ] && kill -0 "$lp" 2>/dev/null && [ "$(ps -o uid= -p "$lp" 2>/dev/null | tr -d " ")" = "${uid}" ]; then echo "$lp" > ${pidFile}; fi`;

/**
 * Chromium watchdog: while the user controls a screen (flag file `user-control`), a closed Chromium
 * comes back within about a second with the same profile and its last session. It is a small loop
 * process with its own pid file (`chromiumwatch`), never a pattern kill. The program is written to
 * `watchdog.sh` and takes the display and profile as arguments so it needs no boot-script functions.
 */
function watchdogLines(agentId: string, d: number, starter: 'start_bg' | 'start_agent'): string[] {
  const dir = pidDir(d);
  const ports = screenPorts(d);
  const profile = profileExpr(agentId);
  return [
    `cat > ${shq(dir + '/watchdog.sh')} <<'WATCHDOG_EOF'`,
    'dir=$1; export DISPLAY=$2; profile=$3',
    'while :; do',
    '  if [ -f "$dir/user-control" ]; then',
    '    p=$(cat "$dir/chromium.pid" 2>/dev/null)',
    '    if [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; then',
    `      ${dropForeignLock('"$profile"')}`,
    `      ${adoptChromium('"$profile"', '"$dir/chromium.pid"', '$(id -u)')}`,
    '      p=$(cat "$dir/chromium.pid" 2>/dev/null)',
    '    fi',
    '    if [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; then',
    `      if [ -d "$profile/Default/Sessions" ]; then target=--restore-last-session; else target=${startPageUrl}; fi`,
    `      chromium ${chromiumFlags} --user-data-dir="$profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=${ports.cdp} $target >>"$dir/chromium.log" 2>&1 &`,
    '      echo $! > "$dir/chromium.pid"',
    '    fi',
    '  fi',
    '  sleep 1',
    'done',
    'WATCHDOG_EOF',
    `alive chromiumwatch || ${starter} chromiumwatch sh ${shq(dir + '/watchdog.sh')} ${shq(dir)} :${d} ${profile}`,
  ];
}

/** The user took control: flag it and start the watchdog (idempotent; works on an already-booted display). */
export function userControlStartCommand(agentId: string, displayNo: number): string {
  const dir = pidDir(displayNo);
  return [`mkdir -p ${shq(dir)}`, ...pidHelpers(displayNo), `touch ${shq(dir + '/user-control')}`, ...watchdogLines(agentId, displayNo, 'start_bg'), 'true'].join('\n');
}

/** Control is back with the agent: stop only the watchdog loop. Chromium (a child) is left running. */
export function userControlStopCommand(displayNo: number): string {
  const dir = pidDir(displayNo);
  return [
    `rm -f ${shq(dir + '/user-control')}`,
    `p="${dir}/chromiumwatch.pid"; if [ -f "$p" ]; then kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi`,
    'true',
  ].join('\n');
}

export function startScreenScript(request: ScreenBootRequest): string {
  const ports = screenPorts(request.displayNo);
  const { width, height } = parseResolution(request.resolution);
  const profile = profileExpr(request.agentId);
  const d = request.displayNo;
  const dir = pidDir(d);
  const user = agentUser(request.agentId);
  const home = `"\${SCREEN_HOME:-${agentHome(request.agentId)}}"`;
  return [
    'set -e',
    `export DISPLAY=:${d}`,
    `export TZ=${shq(request.timezone ?? 'UTC')}`,
    // BACKEND 7.9: the boot runs as root. Xvfb has no `-ac`: it takes a per-agent cookie that only that agent's user
    // (and root, for x11vnc and the probes below) can read. Everything that draws or browses runs as the agent's user.
    // SCREEN_NO_ISOLATION is the unit-test seam (fake binaries, no users); the real boot never sets it.
    `AU=${user}; AH=${home}; XA="$AH/.Xauthority"`,
    'if [ -z "${SCREEN_NO_ISOLATION:-}" ]; then',
    '  export XAUTHORITY="$XA"; XVFB_AUTH="-auth $XA"; VNC_AUTH="-auth $XA"',
    '  start_agent() { name=$1; shift; (exec setpriv --reuid="$AU" --regid="$AU" --init-groups env HOME="$AH" USER="$AU" LOGNAME="$AU" XAUTHORITY="$XA" "$@") >>"$(dirname "$(pf "$name")")/$name.log" 2>&1 & echo $! > "$(pf "$name")"; }',
    '  gen_auth() { rm -f "$XA"; (umask 077; xauth -f "$XA" add "$(hostname)/unix:' + String(d) + '" . "$(mcookie)") >/dev/null 2>&1; chown "$AU:$AU" "$XA"; }',
    '  AUID=$(id -u "$AU"); RD=' + rootDir(d),
    'else',
    '  XVFB_AUTH=-ac; VNC_AUTH=; AUID=$(id -u); RD=' + dir,
    '  start_agent() { start_bg "$@"; }',
    '  gen_auth() { :; }',
    'fi',
    `mkdir -p ${profile} ${shq(dir)}`,
    // Root's own pid files and logs are kept out of the agent's reach; anything in the agent's dir that the agent
    // does not own (left by someone who created it first) goes before the dir is handed over.
    '[ -d "$RD" ] || { mkdir -p /run/juno && chmod 0700 /run/juno && mkdir -p "$RD" && chmod 0700 "$RD"; }',
    `[ -n "\${SCREEN_NO_ISOLATION:-}" ] || { chown "$AU:$AU" ${shq(dir)} && chmod 0711 ${shq(dir)} && find ${shq(dir)} -mindepth 1 -maxdepth 1 ! -user "$AU" -exec rm -fr {} +; }`,
    // Recorded so shell commands on this display (displayShell) run in the same timezone.
    `printf '%s' "$TZ" > ${shq(dir + '/tz')}`,
    ...pidHelpers(d),
    // Root services keep their pid files under $RD; the agent's services under the agent's dir.
    `pf() { case "$1" in ${ROOT_SERVICES}) echo "$RD/$1.pid";; *) echo "${dir}/$1.pid";; esac; }`,
    ...killHelpers('$AUID'),
    `ready_xvfb() { for i in $(seq 1 100); do xdpyinfo -display :${d} >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }`,
    `start_xvfb() { gen_auth; start_bg xvfb Xvfb :${d} $XVFB_AUTH -screen 0 ${width}x${height}x24 -dpi 96 -nolisten tcp; }`,
    `alive xvfb || start_xvfb`,
    `if ! ready_xvfb; then kill_root xvfb; sleep 0.3; start_xvfb; ready_xvfb || { echo "Xvfb :${d} did not start"; cat "$RD/xvfb.log"; exit 1; }; fi`,
    // Root probes and x11vnc read the cookie; the display's own state dir belongs to the agent (its watchdog and dock write there).
    `printf '%s' "$XA" > "$RD/xauth"`,
    `alive wm || start_agent wm xfwm4 --display=:${d}`,
    // x11vnc keeps a password so the public websockify port cannot be used without it; the proxy
    // answers the challenge. \`-localhost\` additionally limits who may even reach the port. It runs as root
    // (the VNC ports are root-only by the firewall rules), with the cookie.
    `alive vnc || start_bg vnc x11vnc -display :${d} $VNC_AUTH -forever -shared -localhost -rfbport ${ports.vnc} -passwd ${shq(request.controlPassword)} -quiet`,
    `alive vncview || start_bg vncview x11vnc -display :${d} $VNC_AUTH -forever -shared -viewonly -localhost -rfbport ${ports.readOnlyVnc} -passwd ${shq(request.viewPassword)} -quiet`,
    `alive novnc || start_bg novnc "\${NOVNC_PROXY:-/opt/noVNC/utils/novnc_proxy}" --vnc localhost:${ports.vnc} --listen ${ports.web} --web "\${NOVNC_DIR:-/opt/noVNC}"`,
    `alive novncview || start_bg novncview "\${NOVNC_PROXY:-/opt/noVNC/utils/novnc_proxy}" --vnc localhost:${ports.readOnlyVnc} --listen ${ports.readOnlyWeb} --web "\${NOVNC_DIR:-/opt/noVNC}"`,
    // A live xfwm4 pid can precede its EWMH setup. Wait before creating a new browser window
    // so Chromium's maximization request reaches the WM; never resize an existing user window.
    `ready_wm() { for i in $(seq 1 60); do xdotool get_desktop >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }`,
    // The helper owns the bottom panel and its reserved work area. It must be installed in the
    // image: a missing helper fails here with an actionable message, never a Dock-less "ready"
    // screen. Only its live PID plus ready marker allow a new Chromium to maximize; reconnects
    // reuse both existing processes.
    `start_dock() { rm -f "${dir}/dock.ready"; h="\${SCREEN_DOCK:-/usr/local/bin/agent-screen-dock}"; [ -x "$h" ] || { echo "screen :${d} cannot start the Dock helper: $h is missing or not executable in this image; rebuild the sandbox template so /usr/local/bin/agent-screen-dock is installed (there is no runtime fallback)"; exit 1; }; ready_wm || { echo "xfwm4 :${d} did not become ready"; cat "${dir}/wm.log" 2>/dev/null || true; exit 1; }; start_agent dock "$h" ${d} ${profile} ${shq(dir)}; }`,
    `ready_dock() { for i in $(seq 1 60); do alive dock || return 1; [ -f "${dir}/dock.ready" ] && return 0; sleep 0.25; done; return 1; }`,
    // The state dir must be the agent's before its dock and watchdog write into it (dock.ready, config/, chromium.pid).
    `start_chromium() { ready_wm || { echo "xfwm4 :${d} did not become ready"; cat "${dir}/wm.log" 2>/dev/null || true; exit 1; }; ${dropForeignLock(profile)}; if [ -d ${profile}/Default/Sessions ]; then target=--restore-last-session; else target=${startPageUrl}; fi; start_agent chromium chromium ${chromiumFlags} --user-data-dir=${profile} --remote-debugging-address=127.0.0.1 --remote-debugging-port=${ports.cdp} $target; }`,
    // Readiness is the live browser WE started, not its start-page title: navigation changes the
    // title while the window, profile and CDP stay healthy. `xdotool` reads DISPLAY, and the
    // window's _NET_WM_PID ties it to the exact Chromium pid recorded for this display, so a
    // navigated browser is reused instead of being killed and re-launched.
    `window_owned() { p=$(cat "$(pf chromium)" 2>/dev/null) || return 1; [ -n "$p" ] && kill -0 "$p" 2>/dev/null || return 1; xdotool search --pid "$p" >/dev/null 2>&1; }`,
    `ready_cdp() { for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:${ports.cdp}/json/version" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }`,
    `ready_browser() { for i in $(seq 1 60); do window_owned && ready_cdp && return 0; sleep 0.25; done; return 1; }`,
    `adopt_chromium() { ${adoptChromium(profile, `"${dir}/chromium.pid"`, '$AUID')}; }`,
    `alive dock || start_dock`,
    `ready_dock || { echo "Dock :${d} failed before reserving its work area"; cat "${dir}/dock.log" 2>/dev/null || true; kill_agent dock; exit 1; }`,
    `alive chromium || adopt_chromium`,
    `alive chromium || start_chromium`,
    // A pid is not "ready": a stale Chromium (older boot, different profile, or crashed) can be
    // alive with no owned window or no CDP. Restart it once, then fail loudly with the log.
    `if ! ready_browser; then kill_agent chromium; sleep 0.5; start_chromium; fi`,
    `ready_browser || { echo "chromium :${d} did not become ready"; cat "${dir}/chromium.log" 2>/dev/null || true; exit 1; }`,
    // The watchdog survives a re-boot while the user still holds the screen.
    `if [ -f "${dir}/user-control" ]; then`,
    ...watchdogLines(request.agentId, d, 'start_agent'),
    'fi',
    // Pid files and logs written by root since the chown above: the agent's watchdog must be able to rewrite chromium.pid.
    `[ -n "\${SCREEN_NO_ISOLATION:-}" ] || chown "$AU:$AU" "${dir}"/* 2>/dev/null || true`,
    `ready_port() { for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$1/vnc.html" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }`,
    `ready_port ${ports.web} || echo "warn: novnc :${d} not answering yet"`,
    `ready_port ${ports.readOnlyWeb} || echo "warn: novnc view :${d} not answering yet"`,
    `echo "screen :${d} ready"`,
  ].join('\n');
}

/**
 * Stop every process one display owns, by pid file; no pattern matching. Root's services come from the root-only
 * directory. The agent's own (browser, window manager, dock, watchdog) come from files that agent can write, so a
 * recorded pid is signalled only if that process belongs to the uid owning the state directory.
 */
export function stopScreenCommand(displayNo: number): string {
  const dir = pidDir(displayNo);
  return [
    `RD=${rootDir(displayNo)}; [ -z "\${SCREEN_NO_ISOLATION:-}" ] || RD=${dir}`,
    `pf() { case "$1" in ${ROOT_SERVICES}) echo "$RD/$1.pid";; *) echo "${dir}/$1.pid";; esac; }`,
    `AUID=$(ls -nd ${shq(dir)} 2>/dev/null | awk '{print $3}')`,
    ...killHelpers('$AUID'),
    // An unknown or root owner means there is no agent process to prove: those files are only dropped.
    `for n in chromiumwatch novncview novnc vncview vnc chromium dock wm xvfb; do case "$n" in ${ROOT_SERVICES}) kill_root "$n";; *) if [ -n "$AUID" ] && [ "$AUID" != 0 ]; then kill_agent "$n"; else rm -f "$(pf "$n")"; fi;; esac; done`,
    `rm -f "${dir}/dock.ready" "${dir}/user-control"`,
    'true',
  ].join('\n');
}

/** The pre-isolation stop (the migration only: those pid files were written by trusted, sudo-holding processes). */
export function legacyStopScreenCommand(displayNo: number): string {
  const dir = pidDir(displayNo);
  return [
    `for n in chromiumwatch novncview novnc vncview vnc chromium dock wm xvfb; do p="${dir}/$n.pid"; ` +
      `if [ -f "$p" ]; then pkill -P "$(cat "$p")" 2>/dev/null || true; kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi; done`,
    `rm -f "${dir}/dock.ready" "${dir}/user-control"`,
  ].join('\n');
}

/**
 * Boot one display in its own POSIX shell. The E2B SDK evaluates its argument inside a
 * Bash `environment` function under `bash -l -c`; a program that sets `set -e` and `exit`s from one
 * of its own functions corrupts that wrapper's variable context, so Bash prints an internal
 * `pop_var_context` error on stderr and the status stops describing the program. Handing the program
 * to an explicit `/bin/sh -c` runs it in a separate process, so the exit code, stdout and stderr the
 * SDK returns are the boot program's own.
 */
export const isolatedShellCommand = (program: string) => `/bin/sh -c ${shq(program)}`;

/** The SDK command that boots one display: the whole boot program inside its own POSIX shell. */
export const bootScreenCommand = (request: ScreenBootRequest) => isolatedShellCommand(startScreenScript(request));

/**
 * Run the boot program and map any failure to a safe operator error. E2B signals a non-zero exit by
 * THROWING a `CommandExitError` (message "exit status N") that `instanceof` cannot detect across
 * the `@e2b/desktop` (CJS) / `e2b` (ESM) split, so the code detects the failure by shape.
 */
export async function bootScreen(runtime: SandboxRuntime, request: ScreenBootRequest): Promise<void> {
  const secrets = [request.controlPassword, request.viewPassword];
  try {
    const result = await runtime.run(bootScreenCommand(request), { timeoutMs: 180_000 });
    if (result.exitCode !== 0) throw failed(screenStartFailure(request.displayNo, result, secrets));
  } catch (error) {
    if (error instanceof ComputerdError) throw error;
    throw failed(screenStartFailure(request.displayNo, error, secrets));
  }
}

/** The live handle a booted display reports: its ports plus the framebuffer size the request asked for. */
export function screenHandle(request: ScreenBootRequest): ScreenHandle {
  const ports = screenPorts(request.displayNo);
  const { width, height } = parseResolution(request.resolution);
  return {
    displayNo: request.displayNo,
    vncPort: ports.vnc,
    viewVncPort: ports.readOnlyVnc,
    webPort: ports.web,
    viewWebPort: ports.readOnlyWeb,
    cdpPort: ports.cdp,
    width,
    height,
    state: 'live',
  };
}
