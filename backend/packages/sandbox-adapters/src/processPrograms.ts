/**
 * The shell protocol behind the sandbox process seam. Every verb is one POSIX `sh` program run
 * inside the bound sandbox; all state lives in the sandbox filesystem, so a handle stays addressable
 * across separate calls and a computerd restart. Each program prints ONE status line on stdout
 * (UNKNOWN/DENIED/NOPIPE/NOCWD/OK or state/exit/total); output payloads go to a per-read slice file
 * the caller reads back as bytes. No host process is ever spawned and no PTY is allocated.
 */
import { shq } from './screen-boot.js';
import type { ProcessStartInput } from './types.js';

export const STOPPED_EXIT_CODE = 143;
const CLEANUP_TTL_MINUTES = 10;
/** `exec`s its arguments after moving the process into a new process group (perl ships on macOS and Debian). */
const PERL_SETPGRP = 'perl -e ' + shq('setpgrp(0,0) or die; exec @ARGV or die');

/** Shared prologue: name the handle dir and re-check the requesting agent's scope on every verb. */
function guard(dir: string, agentId: string): string[] {
  return [
    'D=' + shq(dir),
    '[ -d "$D" ] || { printf "UNKNOWN\\n"; exit 3; }',
    '[ "$(cat "$D/scope" 2>/dev/null)" = ' + shq(agentId) + ' ] || { printf "DENIED\\n"; exit 4; }',
  ];
}

export function startProgram(dir: string, agentId: string, input: ProcessStartInput): string {
  const inner = input.command + '\nec=$?\nprintf %s "$ec" > ' + shq(dir + '/exit');
  // A missing working directory fails BEFORE anything is launched, so a bad cwd can never silently
  // run the command somewhere else.
  const cwdCheck = input.cwd === undefined ? '' : '[ -d ' + shq(input.cwd) + ' ] || { printf "NOCWD\\n"; exit 6; }';
  const enter = input.cwd === undefined ? '' : ' cd ' + shq(input.cwd) + ' &&';
  const launch = (head: string) =>
    '(' + enter + ' exec ' + head + ' ' + shq(inner) + ' <> ' + shq(dir + '/stdin') + ' >> ' + shq(dir + '/out') + ' 2>> ' + shq(dir + '/err') + ' ) &';
  return [
    'D=' + shq(dir),
    ...(cwdCheck === '' ? [] : [cwdCheck]),
    'mkdir -p "$D"',
    'printf %s ' + shq(agentId) + ' > "$D/scope"',
    ': > "$D/out"',
    ': > "$D/err"',
    'mkfifo "$D/stdin" 2>/dev/null',
    // Each program leads its own process group (pgid = pid), so stop can signal the wrapper and everything
    // it spawned. setsid does it on Linux; perl's setpgrp does it where setsid is missing (macOS).
    'if command -v setsid >/dev/null 2>&1; then ' + launch('setsid sh -c') + ' printf 1 > "$D/grouped"; ' +
      'elif command -v perl >/dev/null 2>&1; then ' + launch(PERL_SETPGRP + ' sh -c') + ' printf 1 > "$D/grouped"; ' +
      'else ' + launch('sh -c') + ' printf 0 > "$D/grouped"; fi',
    'PID=$!',
    'printf %s "$PID" > "$D/pid"',
    ...(input.timeoutMs === undefined ? [] : [timeoutProgram(input.timeoutMs)]),
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$D/started"',
    'printf "%s\\t%s\\n" "$PID" "$(cat "$D/started")"',
  ].join('\n');
}

/**
 * The wall-clock limit of a started process (ProcessStartInput.timeoutMs), which the sandbox used to drop.
 * A detached watchdog ends it when the limit is reached: it writes exit 124 first, so the process reads as
 * exited with that code, and it signals only while the recorded pid is still this handle's process (the
 * same ownership check stopProgram uses). It polls once a second and returns as soon as the process exits or
 * is stopped, so a process that finishes early leaves no sleeper behind. Its stdio is detached, so the start
 * call returns at once.
 */
function timeoutProgram(timeoutMs: number): string {
  const mine = 'ps -o command= -p "$PID" 2>/dev/null | grep -q -e "$D"';
  const end = 'printf 124 > "$D/exit"; if [ "$(cat "$D/grouped" 2>/dev/null)" = 1 ]; then kill -TERM -- "-$PID" 2>/dev/null; else kill -TERM "$PID" 2>/dev/null; fi';
  const ended = '[ -f "$D/exit" ] || [ -f "$D/stopped" ]';
  return '( LIMIT=$(( $(date +%s) + ' + String(Math.ceil(timeoutMs / 1000)) + ' )); while ! { ' + ended + '; } && [ "$(date +%s)" -lt "$LIMIT" ]; do sleep 1; done; ' + ended + ' || { ' + mine + ' && { ' + end + '; }; } ) </dev/null >/dev/null 2>&1 &';
}

/**
 * Read new output. The slice path is passed in per call, so two concurrent polls (different cursors)
 * never share a scratch file.
 */
export function readProgram(dir: string, agentId: string, cursor: number, stderrCursor: number, maxBytes: number, out: string, err: string): string {
  return [
    ...guard(dir, agentId),
    'if [ -f "$D/exit" ]; then ST=exited; RC=$(cat "$D/exit")',
    'elif [ -f "$D/stopped" ]; then ST=stopped; RC=$(cat "$D/stopped")',
    'elif kill -0 "$(cat "$D/pid" 2>/dev/null)" 2>/dev/null; then ST=running; RC=-',
    'else ST=expired; RC=-; fi',
    'outTotal=$(wc -c < "$D/out" | tr -d " ")',
    'errTotal=$(wc -c < "$D/err" | tr -d " ")',
    '[ "$outTotal" -gt ' + cursor + ' ] && tail -c +' + (cursor + 1) + ' "$D/out" | head -c ' + maxBytes + ' > ' + shq(out),
    '[ "$errTotal" -gt ' + stderrCursor + ' ] && tail -c +' + (stderrCursor + 1) + ' "$D/err" | head -c ' + maxBytes + ' > ' + shq(err),
    'printf "%s\\t%s\\t%s\\t%s\\n" "$ST" "$RC" "$outTotal" "$errTotal"',
  ].join('\n');
}

export function writeProgram(dir: string, agentId: string, data: string): string {
  return [
    ...guard(dir, agentId),
    '[ -p "$D/stdin" ] || { printf "NOPIPE\\n"; exit 5; }',
    'printf %s ' + shq(data) + ' > "$D/stdin"',
    'printf "OK\\n"',
  ].join('\n');
}

export function stopProgram(dir: string, agentId: string): string {
  return [
    ...guard(dir, agentId),
    'if [ -f "$D/exit" ]; then printf "exited\\t%s\\n" "$(cat "$D/exit")"; exit 0; fi',
    'if [ -f "$D/stopped" ]; then printf "stopped\\t%s\\n" "$(cat "$D/stopped")"; exit 0; fi',
    'PID=$(cat "$D/pid" 2>/dev/null || printf "")',
    // Never signal a pid we cannot prove is ours: the recorded command line must still carry this
    // handle's unique directory (a recycled pid belongs to another process). A pid we cannot inspect
    // is reported as expired rather than killed.
    'mine() { ps -o command= -p "$PID" 2>/dev/null | grep -q -e "$D"; }',
    'if [ -z "$PID" ] || ! command -v ps >/dev/null 2>&1; then printf "expired\\t-\\n"; exit 0; fi',
    'if mine; then :; else printf "expired\\t-\\n"; exit 0; fi',
    // A grouped program is signalled as its process group (negative pid): the group id stays reserved
    // while any member lives, so it cannot be a recycled pid. An ungrouped one is signalled by pid only.
    'if [ "$(cat "$D/grouped" 2>/dev/null)" = 1 ]; then G=1; T="-$PID"; else G=0; T=$PID; fi',
    'kill -TERM "$T" 2>/dev/null',
    'i=0; while kill -0 "$T" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done',
    'if [ "$G" = 1 ] || mine; then kill -KILL "$T" 2>/dev/null; fi',
    'printf %s ' + STOPPED_EXIT_CODE + ' > "$D/stopped"',
    'printf "stopped\\t' + STOPPED_EXIT_CODE + '\\n"',
  ].join('\n');
}

export function cleanupProgram(scopeDir: string): string {
  return [
    'S=' + shq(scopeDir),
    '[ -d "$S" ] || exit 0',
    'for d in "$S"/p_*; do',
    '  [ -d "$d" ] || continue',
    '  if [ -f "$d/exit" ] || [ -f "$d/stopped" ]; then',
    '    [ -n "$(find "$d" -maxdepth 0 -mmin +' + CLEANUP_TTL_MINUTES + ' 2>/dev/null)" ] && rm -rf "$d"',
    '  fi',
    'done',
  ].join('\n');
}
