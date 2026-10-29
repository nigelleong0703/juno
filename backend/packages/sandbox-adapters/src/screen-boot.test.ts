/**
 * A real run of the boot program against fake binaries, because the original bug (a \`pgrep -f\`
 * self-match) could only be seen by executing it. The fakes stand in for Xvfb/xfwm4/x11vnc/novnc/
 * chromium so the test proves the process management, not the sandbox tooling:
 *  - the script starts every service and exits 0 (a broken display now fails, not "succeeds");
 *  - running it twice reuses the same pids (idempotent, safe after a reconnect);
 *  - \`stopScreenCommand\` actually kills them, so the next boot starts fresh.
 *
 * Every run is under a hard timeout: a hanging boot must fail the test, never wedge the runner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandExitError } from 'e2b';
import {
  bootScreenCommand,
  displayShell,
  chromiumFlags,
  startPageUrl,
  isolatedShellCommand,
  pidDir,
  screenStartFailure,
  shq,
  startScreenScript,
  stopScreenCommand,
  userControlStartCommand,
  userControlStopCommand,
} from './screen-boot.js';
import { screenPorts } from './ports.js';

// Per-process display number: a fixed one made concurrent runs of this fixture share /tmp pid
// files and stop each other's fake daemons.
const DISPLAY = 4000 + (process.pid % 20000);
const REQUEST = {
  agentId: 'agent-fixture',
  displayNo: DISPLAY,
  resolution: '640x480',
  controlPassword: 'ctl-pw',
  viewPassword: 'view-pw',
};

let bin: string;
let home: string;

const fake = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

const run = (script: string, extraEnv: Record<string, string> = {}) =>
  execFileSync('sh', ['-c', script], {
    timeout: 8000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      SCREEN_HOME: home,
      NOVNC_PROXY: join(bin, 'novnc_proxy'),
      NOVNC_DIR: bin,
      SCREEN_DOCK: join(bin, 'agent-screen-dock'),
      // Fake binaries and no agent users here: the isolation (setpriv, X cookie, chown) is covered by the live docker test.
      SCREEN_NO_ISOLATION: '1',
      ...extraEnv,
    },
  });

const pidPath = (name: string) => join(pidDir(DISPLAY), `${name}.pid`);
const readPid = (name: string) => Number(execFileSync('cat', [pidPath(name)]).toString().trim());
const alive = (name: string) => {
  try {
    process.kill(readPid(name), 0);
    return true;
  } catch {
    return false;
  }
};

describe('screen boot program (real sh, fake tools)', () => {
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'sb-fixture-'));
    home = mkdtempSync(join(tmpdir(), 'sb-home-'));
    // Long-lived daemons; \`xdpyinfo\` succeeds immediately (it is a probe, not a daemon).
    for (const name of ['Xvfb', 'xfwm4', 'x11vnc', 'novnc_proxy']) fake(name, 'exec sleep 120');
    fake('chromium', [
      '[ "$(cat "$SCREEN_HOME/wm-ready")" = ready ] || exit 9',
      `[ -f "${pidDir(DISPLAY)}/dock.ready" ] || exit 10`,
      'printf "chromium\\n" >> "$SCREEN_HOME/launch-order"',
      'printf "%s\\n" "DISPLAY=$DISPLAY" "$@" >> "$SCREEN_HOME/chromium-args"',
      'exec sleep 120',
    ].join('\n'));
    fake('xdpyinfo', 'exit 0');
    fake('curl', 'exit 0');
  });

  beforeEach(() => {
    fake('sleep', 'exec /bin/sleep "$@"');
    writeFileSync(join(home, 'chromium-args'), '');
    writeFileSync(join(home, 'xdotool-args'), '');
    writeFileSync(join(home, 'wm-ready'), '');
    writeFileSync(join(home, 'dock-args'), '');
    writeFileSync(join(home, 'launch-order'), '');
    fake('agent-screen-dock', [
      '[ "$(cat "$SCREEN_HOME/wm-ready")" = ready ] || exit 11',
      'printf "%s\\n" "DISPLAY=$DISPLAY" "$@" >> "$SCREEN_HOME/dock-args"',
      'printf "dock\\n" >> "$SCREEN_HOME/launch-order"',
      'touch "$3/dock.ready"',
      'exec sleep 120',
    ].join('\n'));
    fake('xdotool', [
      'printf "%s\\n" "$@" >> "$SCREEN_HOME/xdotool-args"',
      'if [ "$1" = get_desktop ]; then printf ready > "$SCREEN_HOME/wm-ready"; fi',
      'if [ "$1" = search ]; then test -s "$SCREEN_HOME/chromium-args"; exit $?; fi',
      'exit 0',
    ].join('\n'));
  });

  afterEach(() => {
    try {
      run(stopScreenCommand(DISPLAY));
    } catch {
      // nothing running
    }
  });

  it('starts every service, is idempotent, then stops everything', () => {
    run(startScreenScript(REQUEST));
    for (const name of ['xvfb', 'wm', 'dock', 'vnc', 'vncview', 'novnc', 'novncview', 'chromium']) {
      expect(existsSync(pidPath(name)), `${name} pid file`).toBe(true);
      expect(alive(name), `${name} alive`).toBe(true);
    }
    const first = { xvfb: readPid('xvfb'), dock: readPid('dock'), chromium: readPid('chromium') };

    run(startScreenScript(REQUEST));
    expect(readPid('xvfb')).toBe(first.xvfb);
    expect(readPid('chromium')).toBe(first.chromium);
    expect(readPid('dock')).toBe(first.dock);
    expect(readFileSync(join(home, 'launch-order'), 'utf8')).toBe('dock\nchromium\n');
    expect(readFileSync(join(home, 'dock-args'), 'utf8').trim().split('\n')).toEqual([
      `DISPLAY=:${DISPLAY}`, String(DISPLAY), `${home}/.config/chromium`, pidDir(DISPLAY),
    ]);

    run(stopScreenCommand(DISPLAY));
    expect(existsSync(pidPath('xvfb'))).toBe(false);
    expect(alive('xvfb')).toBe(false);
    expect(existsSync(pidPath('dock'))).toBe(false);
    expect(existsSync(join(pidDir(DISPLAY), 'dock.ready'))).toBe(false);
    expect(() => process.kill(first.dock, 0)).toThrow();
  });

  it('runs the screen in the configured timezone, UTC when none is given', () => {
    expect(startScreenScript({ ...REQUEST, timezone: 'Asia/Singapore' })).toContain("export TZ='Asia/Singapore'");
    expect(startScreenScript(REQUEST)).toContain("export TZ='UTC'");
    // Shell commands on the display read the zone the boot recorded, so `date` matches the screen clock.
    expect(startScreenScript(REQUEST)).toContain(`> '${pidDir(REQUEST.displayNo)}/tz'`);
    const tz = join(pidDir(REQUEST.displayNo), 'tz');
    mkdirSync(pidDir(REQUEST.displayNo), { recursive: true });
    writeFileSync(tz, 'Asia/Singapore');
    expect(execFileSync('/bin/sh', ['-c', displayShell(REQUEST.displayNo, 'echo "$TZ"')], { encoding: 'utf8' }).trim()).toBe('Asia/Singapore');
    rmSync(tz);
    expect(execFileSync('/bin/sh', ['-c', displayShell(REQUEST.displayNo, 'echo "$TZ"')], { encoding: 'utf8' }).trim()).toBe('UTC');
  });

  it('restarts a display whose recorded process is dead', () => {
    run(startScreenScript(REQUEST));
    const staleXvfb = readPid('xvfb');
    process.kill(staleXvfb, 'SIGKILL');
    run(startScreenScript(REQUEST));
    expect(readPid('xvfb')).not.toBe(staleXvfb);
    expect(alive('xvfb')).toBe(true);
  });

  it('requests maximization on the agent display once, preserving its profile and existing window', () => {
    run(startScreenScript(REQUEST));
    const args = readFileSync(join(home, 'chromium-args'), 'utf8').trim().split('\n');
    expect(args).toContain(`DISPLAY=:${DISPLAY}`);
    expect(args.filter((arg) => arg === '--start-maximized')).toHaveLength(1);
    expect(args).toContain(`--user-data-dir=${home}/.config/chromium`);
    expect(args).toContain(`--remote-debugging-port=${screenPorts(DISPLAY).cdp}`);
    expect(args).toContain(startPageUrl);
    expect(chromiumFlags.split(' ')).toContain('--start-maximized');
    const firstPid = readPid('chromium');
    const firstLaunch = readFileSync(join(home, 'chromium-args'), 'utf8');
    run(startScreenScript(REQUEST));
    expect(readPid('chromium')).toBe(firstPid);
    expect(readFileSync(join(home, 'chromium-args'), 'utf8')).toBe(firstLaunch);
    // All xdotool calls are probes: no windowmove/windowsize/key action on a live window.
    const probes = readFileSync(join(home, 'xdotool-args'), 'utf8');
    // Window arrival is asynchronous, so search may retry before the fake has logged its args. The
    // probe names the recorded chromium pid, never the start-page title.
    expect(probes).toMatch(new RegExp(`^get_desktop\\nget_desktop\\n(search\\n--pid\\n${firstPid}\\n)+$`));
  });

  it('reuses a live browser whose page navigated away instead of restarting it', () => {
    // A navigated browser no longer carries the start-page title, but it still owns a window for
    // the pid we launched and still answers CDP. Readiness must accept it and keep the same process.
    fake('xdotool', [
      'printf "%s\\n" "$@" >> "$SCREEN_HOME/xdotool-args"',
      'if [ "$1" = get_desktop ]; then printf ready > "$SCREEN_HOME/wm-ready"; exit 0; fi',
      'case "$*" in *--name*) exit 1 ;; esac',
      'test -s "$SCREEN_HOME/chromium-args"; exit $?',
    ].join('\n'));
    run(startScreenScript(REQUEST));
    const pid = readPid('chromium');
    run(startScreenScript(REQUEST));
    expect(readPid('chromium')).toBe(pid);
    expect(alive('chromium')).toBe(true);
    expect(readFileSync(join(home, 'launch-order'), 'utf8')).toBe('dock\nchromium\n');
  });

  it('waits for delayed WM readiness before launching the maximized browser', () => {
    fake('xdotool', [
      'if [ "$1" != get_desktop ]; then test -s "$SCREEN_HOME/chromium-args"; exit $?; fi',
      'printf "%s\\n" probe >> "$SCREEN_HOME/wm-probes"',
      'if [ "$(wc -l < "$SCREEN_HOME/wm-probes")" -lt 3 ]; then exit 1; fi',
      'printf ready > "$SCREEN_HOME/wm-ready"',
    ].join('\n'));
    writeFileSync(join(home, 'wm-probes'), '');
    run(startScreenScript(REQUEST));
    expect(readFileSync(join(home, 'wm-probes'), 'utf8').trim().split('\n')).toHaveLength(4);
    expect(alive('chromium')).toBe(true);
    expect(readFileSync(join(home, 'chromium-args'), 'utf8').trim().split('\n'))
      .toContain('--start-maximized');
  });

  it('waits for the Dock reserved-area marker before starting Chromium', () => {
    fake('agent-screen-dock', [
      '[ "$(cat "$SCREEN_HOME/wm-ready")" = ready ] || exit 11',
      'printf "dock\\n" >> "$SCREEN_HOME/launch-order"',
      'sleep 0.5',
      '[ ! -s "$SCREEN_HOME/chromium-args" ] || exit 12',
      'printf "reserved\\n" >> "$SCREEN_HOME/launch-order"',
      'touch "$3/dock.ready"',
      'exec sleep 120',
    ].join('\n'));
    run(startScreenScript(REQUEST));
    expect(readFileSync(join(home, 'launch-order'), 'utf8')).toBe('dock\nreserved\nchromium\n');
    expect(alive('dock')).toBe(true);
    expect(alive('chromium')).toBe(true);
  });

  it('fails with helper diagnostics when the Dock dies, ignoring a stale ready marker', () => {
    fake('agent-screen-dock', 'echo "fixture Dock failed"; exit 13');
    run(`mkdir -p "${pidDir(DISPLAY)}"; touch "${pidDir(DISPLAY)}/dock.ready"`);
    try {
      run(startScreenScript(REQUEST));
      expect.fail('boot must fail when Dock exits');
    } catch (error) {
      if (!(error instanceof Error) || !('stdout' in error) || !Buffer.isBuffer(error.stdout)) throw error;
      expect(error.stdout.toString()).toContain(`Dock :${DISPLAY} failed before reserving its work area`);
      expect(error.stdout.toString()).toContain('fixture Dock failed');
    }
    expect(readFileSync(join(home, 'chromium-args'), 'utf8')).toBe('');
    expect(existsSync(pidPath('dock'))).toBe(false);
    expect(existsSync(join(pidDir(DISPLAY), 'dock.ready'))).toBe(false);
  });

  it('bounds the wait and stops a live Dock that never establishes its work area', () => {
    fake('agent-screen-dock', 'echo "fixture reservation pending"; exec sleep 120');
    // Keep the production retry count, but skip only its 250ms sleeps in this failure fixture.
    fake('sleep', [
      'if [ "$1" != 0.25 ]; then exec /bin/sleep "$@"; fi',
      'printf "retry\\n" >> "$SCREEN_HOME/dock-retries"',
    ].join('\n'));
    writeFileSync(join(home, 'dock-retries'), '');
    try {
      run(startScreenScript(REQUEST));
      expect.fail('boot must fail when Dock never becomes ready');
    } catch (error) {
      if (!(error instanceof Error) || !('stdout' in error) || !Buffer.isBuffer(error.stdout)) throw error;
      expect(error.stdout.toString()).toContain(`Dock :${DISPLAY} failed before reserving its work area`);
      expect(error.stdout.toString()).toContain('fixture reservation pending');
    }
    expect(readFileSync(join(home, 'dock-retries'), 'utf8').trim().split('\n')).toHaveLength(60);
    expect(readFileSync(join(home, 'chromium-args'), 'utf8')).toBe('');
    expect(existsSync(pidPath('dock'))).toBe(false);
    expect(existsSync(join(pidDir(DISPLAY), 'dock.ready'))).toBe(false);
  });

  it('finds a reparented panel through EWMH client IDs and validates its class before struts', () => {
    const helper = readFileSync(new URL('../../sandbox-image/files/agent-screen-dock', import.meta.url), 'utf8');
    const probes = helper.slice(helper.indexOf('root_height() {'), helper.indexOf('\ntries=0'));
    fake('xwininfo', 'printf "  Height: 800\\n"');
    fake('xprop', [
      'case "$*" in',
      '  "-root _NET_WORKAREA") echo "_NET_WORKAREA(CARDINAL) = 0, 0, 1280, 751" ;;',
      '  "-root _NET_CLIENT_LIST") echo "_NET_CLIENT_LIST(WINDOW): window id # 0x111, 0x222" ;;',
      '  "-id 0x111 WM_CLASS") echo \'WM_CLASS(STRING) = "chromium", "Chromium"\' ;;',
      '  "-id 0x222 WM_CLASS") echo \'WM_CLASS(STRING) = "xfce4-panel", "Xfce4-panel"\' ;;',
      '  "-id 0x222 _NET_WM_STRUT_PARTIAL") echo "_NET_WM_STRUT_PARTIAL(CARDINAL) = 0, 0, 0, 49, 0, 0, 0, 0, 0, 0, 0, 1279" ;;',
      '  *) echo "unexpected probe: $*" >&2; exit 1 ;;',
      'esac',
    ].join('\n'));
    expect(run(`set -eu\n${probes}\ndock_reserved\necho reserved`).toString().trim()).toBe('reserved');
    fake('xprop', [
      'case "$*" in',
      '  "-root _NET_WORKAREA") echo "_NET_WORKAREA(CARDINAL) = 0, 0, 1280, 751" ;;',
      '  "-root _NET_CLIENT_LIST") echo "_NET_CLIENT_LIST(WINDOW): window id # 0x111" ;;',
      '  "-id 0x111 WM_CLASS") echo \'WM_CLASS(STRING) = "chromium", "Chromium"\' ;;',
      '  *) echo "_NET_WM_STRUT(CARDINAL) = 0, 0, 0, 49" ;;',
      'esac',
    ].join('\n'));
    expect(run(`set -eu\n${probes}\nif dock_reserved; then echo unexpected; else echo rejected; fi`)
      .toString().trim()).toBe('rejected');
  });

  it('sends the boot program verbatim to an isolated POSIX shell', () => {
    const program = startScreenScript(REQUEST);
    const command = bootScreenCommand(REQUEST);
    expect(command).toBe(`/bin/sh -c ${shq(program)}`);
    // A real POSIX shell re-parses the quoted argument back to the byte-identical program.
    const argument = command.slice('/bin/sh -c '.length);
    expect(execFileSync('/bin/sh', ['-c', `printf '%s' ${argument}`], { encoding: 'utf8' })).toBe(program);
  });

  it('keeps the program out of the invoking shell, so the SDK Bash function cannot corrupt it', () => {
    // `environment` mimics the SDK wrapper: the command is evaluated in the caller's own shell.
    const sdk = 'environment() { eval "$1"; }; environment "$1"; command -v leaked_marker >/dev/null && echo leaked || echo isolated';
    const program = 'set -e\nleaked_marker() { :; }\ntrue';
    expect(spawnSync('/bin/bash', ['-c', sdk, '_', program], { encoding: 'utf8' }).stdout.trim()).toBe('leaked');
    expect(
      spawnSync('/bin/bash', ['-c', sdk, '_', isolatedShellCommand(program)], { encoding: 'utf8' }).stdout.trim(),
    ).toBe('isolated');
  });

  it("returns the program's own exit code and output across the SDK shell boundary", () => {
    const program = 'set -e\nstart() { echo expected-helper-failure; exit 7; }\nstart';
    const sdk = 'environment() { eval "$1"; }; environment "$1"; exit $?';
    const result = spawnSync('/bin/bash', ['-c', sdk, '_', isolatedShellCommand(program)], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('expected-helper-failure\n');
    expect(result.stderr).toBe('');
  });

  it('boots the display when the SDK runs the isolated command through its own shell', () => {
    run(bootScreenCommand(REQUEST));
    for (const name of ['xvfb', 'wm', 'dock', 'vnc', 'vncview', 'novnc', 'novncview', 'chromium']) {
      expect(existsSync(pidPath(name)), `${name} pid file`).toBe(true);
      expect(alive(name), `${name} alive`).toBe(true);
    }
  });

  it('reports the real Dock failure across the SDK boundary without shell noise', () => {
    const missing = join(bin, 'not-installed-dock');
    try {
      run(bootScreenCommand(REQUEST), { SCREEN_DOCK: missing });
      expect.fail('boot must fail when the Dock helper is missing');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('stdout' in error) ||
        !('stderr' in error) ||
        !Buffer.isBuffer(error.stdout)
      ) {
        throw error;
      }
      expect(error.stdout.toString()).toContain('cannot start the Dock helper');
      expect(String(error.stderr)).not.toContain('pop_var_context');
    }
  });

  it('maps a real SDK CommandExitError to an actionable message without the VNC passwords', () => {
    const exit = new CommandExitError({
      exitCode: 1,
      error: 'exit status 1',
      stdout: '',
      stderr: 'line 7: /usr/local/bin/agent-screen-dock: No such file or directory',
    });
    expect(screenStartFailure(DISPLAY, exit, [REQUEST.controlPassword, REQUEST.viewPassword])).toBe(
      `screen :${DISPLAY} failed to start (exit 1): line 7: /usr/local/bin/agent-screen-dock: No such file or directory`,
    );
    const leaked = screenStartFailure(
      DISPLAY,
      new CommandExitError({ exitCode: 3, error: 'exit status 3', stdout: 'out', stderr: `x11vnc -passwd ${REQUEST.controlPassword}` }),
      [REQUEST.controlPassword],
    );
    expect(leaked).not.toContain(REQUEST.controlPassword);
    expect(leaked).toContain('[redacted]');
  });

  it('keeps the real stdout diagnostic when the shell also wrote an internal error to stderr', () => {
    const exit = new CommandExitError({
      exitCode: 1,
      error: 'exit status 1',
      stdout: `Dock :${DISPLAY} failed before reserving its work area`,
      stderr: 'environment: line 23: pop_var_context: head of shell_variables not a function context',
    });
    const message = screenStartFailure(DISPLAY, exit, [REQUEST.controlPassword]);
    expect(message).toContain(`screen :${DISPLAY} failed to start (exit 1)`);
    expect(message).toContain(`Dock :${DISPLAY} failed before reserving its work area`);
    expect(message).toContain('pop_var_context');
  });

  it('fails fast with an actionable error when the image has no Dock helper', () => {
    const missing = join(bin, 'not-installed-dock');
    try {
      run(startScreenScript(REQUEST), { SCREEN_DOCK: missing });
      expect.fail('boot must fail when the Dock helper is missing');
    } catch (error) {
      if (!(error instanceof Error) || !('stdout' in error) || !Buffer.isBuffer(error.stdout)) throw error;
      expect(error.stdout.toString()).toContain('cannot start the Dock helper');
      expect(error.stdout.toString()).toContain(missing);
    }
    expect(readFileSync(join(home, 'chromium-args'), 'utf8')).toBe('');
    expect(existsSync(pidPath('dock'))).toBe(false);
  });

  it('relaunches a closed Chromium while the user holds control, and stops cleanly', async () => {
    run(startScreenScript(REQUEST));
    run(userControlStartCommand(REQUEST.agentId, DISPLAY));
    expect(alive('chromiumwatch')).toBe(true);
    const before = readPid('chromium');
    mkdirSync(`${home}/.config/chromium/Default/Sessions`, { recursive: true }); // a previous session to restore
    process.kill(before, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (!existsSync(pidPath('chromium')) || readPid('chromium') === before)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(readPid('chromium')).not.toBe(before);
    expect(alive('chromium')).toBe(true);
    expect(readFileSync(join(home, 'chromium-args'), 'utf8')).toContain('--restore-last-session');

    // Hand-back stops only the watchdog: the relaunched browser keeps running, and a later close stays closed.
    run(userControlStopCommand(DISPLAY));
    expect(existsSync(pidPath('chromiumwatch'))).toBe(false);
    expect(alive('chromium')).toBe(true);

    run(stopScreenCommand(DISPLAY));
    expect(existsSync(pidPath('chromium'))).toBe(false);
    expect(existsSync(join(pidDir(DISPLAY), 'user-control'))).toBe(false);
  });

  it('adopts a live Chromium that still owns the profile instead of launching one that would hand off and exit', () => {
    const profile = `${home}/.config/chromium`;
    mkdirSync(profile, { recursive: true });
    const orphan = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
    orphan.unref();
    try {
      const host = execFileSync('hostname').toString().trim();
      rmSync(join(profile, 'SingletonLock'), { force: true });
      symlinkSync(`${host}-${orphan.pid}`, join(profile, 'SingletonLock'));
      mkdirSync(pidDir(DISPLAY), { recursive: true });
      writeFileSync(pidPath('chromium'), '999999\n'); // stale: a launcher that already exited
      writeFileSync(join(home, 'chromium-args'), 'orphan-has-a-window\n'); // the fake xdotool finds a window only when this is non-empty
      run(startScreenScript(REQUEST));
      expect(readPid('chromium')).toBe(orphan.pid);
      expect(readFileSync(join(home, 'launch-order'), 'utf8')).not.toContain('chromium');
    } finally {
      process.kill(orphan.pid!, 'SIGKILL');
      rmSync(join(profile, 'SingletonLock'), { force: true });
    }
  });
});
