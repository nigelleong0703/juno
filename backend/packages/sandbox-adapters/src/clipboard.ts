/**
 * The computer clipboard side channel (M-CLIP). VNC cut-text carries text only, so an image or a file takes this path:
 *  - paste (device -> computer): an image is written to the agent's Pictures and put on the X clipboard with xclip, so the
 *    Ctrl+V the client sends next pastes it; files are saved to the agent's Downloads under a free name.
 *  - copy (computer -> device): asks the X clipboard what it holds (TARGETS) and returns a PNG image if one is offered,
 *    else text, else the first file of a uri-list.
 *
 * Every command runs as the agent on the display (the same display shell as the other screen commands). Bytes move
 * through a staging file in /tmp that the agent writes and root reads or removes, so binary data never travels as text.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { failed } from './errors.js';
import { agentHome } from './isolation-user.js';
import { displayShell } from './screen-boot.js';
import { shq } from './shq.js';
import type { CommandResult, SandboxRuntime } from './runtime.js';
import type { ClipboardCopyResult, ClipboardPaste, ClipboardPasteResult } from './types.js';

const COMMAND_TIMEOUT_MS = 30_000;
/** A copied uri-list is a few lines; anything bigger is not a file list. */
const URI_LIST_MAX_BYTES = 64 * 1024;
/** Text targets, in the order a copy prefers them. */
const TEXT_TARGETS = ['UTF8_STRING', 'text/plain;charset=utf-8', 'text/plain', 'STRING', 'TEXT'];

/** Where the agent keeps pasted images (the screenshots of the computer's own clipboard) and saved files. */
export const pastedImagesDir = (agentId: string) => `${agentHome(agentId)}/Pictures/Pasted`;
export const downloadsDir = (agentId: string) => `${agentHome(agentId)}/Downloads`;

/** A name the agent's Downloads can hold: its last path part, no control characters, no leading dots, bounded. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const printable = [...base].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  const cleaned = printable
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'file';
}

/** `name` split at its last dot; a leading dot is part of the name, not an extension. */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** The first non-empty line of a uri-list that names a local file, as an absolute path; `null` when there is none. */
export function firstFilePath(uriList: string): string | null {
  for (const raw of uriList.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^file:\/\/(?:localhost)?(\/.*)$/.exec(line);
    if (!match) continue;
    try {
      return decodeURIComponent(match[1] ?? '');
    } catch {
      return null;
    }
  }
  return null;
}

export async function pasteToComputer(
  agent: SandboxRuntime,
  agentId: string,
  displayNo: number,
  input: ClipboardPaste,
): Promise<ClipboardPasteResult> {
  const display = displayRunner(agent, displayNo);
  if (input.kind === 'files') return { kind: 'files', saved: await saveFiles(agent, display, agentId, input.files) };
  return { kind: 'image', path: await imageToClipboard(agent, display, agentId, input) };
}

export async function copyFromComputer(
  root: SandboxRuntime,
  agent: SandboxRuntime,
  displayNo: number,
  maxBytes: number,
): Promise<ClipboardCopyResult> {
  const display = displayRunner(agent, displayNo);
  const targets = await display(`timeout 5 xclip -selection clipboard -o -t TARGETS </dev/null 2>/dev/null`);
  // xclip exits non-zero when nothing is selected (no owner, or an empty selection).
  if (targets.exitCode !== 0) return { kind: 'empty' };
  const offered = new Set(targets.stdout.split('\n').map((line) => line.trim()));
  const stage = `/tmp/juno-clip-${randomUUID()}`;
  // Writes the agent's staging file and prints its size; `null` when the command failed or wrote nothing readable.
  const pull = async (command: string): Promise<number | null> => {
    const result = await display(`${command} && stat -c %s -- ${shq(stage)}`);
    if (result.exitCode !== 0) return null;
    const size = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(size) ? size : null;
  };
  try {
    if (offered.has('image/png')) {
      const size = await pull(`timeout 10 xclip -selection clipboard -t image/png -o </dev/null > ${shq(stage)}`);
      if (size === null) return { kind: 'empty' };
      if (size > maxBytes) return { kind: 'tooLarge', sizeBytes: size };
      return { kind: 'image', bytes: await root.readBytes(stage) };
    }
    const textTarget = TEXT_TARGETS.find((target) => offered.has(target));
    if (textTarget !== undefined) {
      const size = await pull(`timeout 10 xclip -selection clipboard -t ${shq(textTarget)} -o </dev/null > ${shq(stage)}`);
      if (size === null) return { kind: 'empty' };
      if (size > maxBytes) return { kind: 'tooLarge', sizeBytes: size };
      return { kind: 'text', text: Buffer.from(await root.readBytes(stage)).toString('utf8') };
    }
    if (offered.has('text/uri-list')) {
      const size = await pull(`timeout 10 xclip -selection clipboard -t text/uri-list -o </dev/null > ${shq(stage)}`);
      if (size === null || size > URI_LIST_MAX_BYTES) return { kind: 'empty' };
      const path = firstFilePath(Buffer.from(await root.readBytes(stage)).toString('utf8'));
      if (path === null) return { kind: 'empty' };
      // The agent copies the file itself, so it can only ever reach what the agent could read.
      const fileSize = await pull(`[ -f ${shq(path)} ] && cp -- ${shq(path)} ${shq(stage)}`);
      if (fileSize === null) return { kind: 'empty' };
      if (fileSize > maxBytes) return { kind: 'tooLarge', sizeBytes: fileSize };
      return { kind: 'file', name: posix.basename(path), bytes: await root.readBytes(stage) };
    }
    return { kind: 'empty' };
  } finally {
    await root.run(`rm -f -- ${shq(stage)}`, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

type Display = (command: string) => Promise<CommandResult>;

function displayRunner(agent: SandboxRuntime, displayNo: number): Display {
  return (command) => agent.run(displayShell(displayNo, command), { envs: { DISPLAY: `:${displayNo}` }, timeoutMs: COMMAND_TIMEOUT_MS });
}

/** Writes each file under a free name in Downloads (an existing name gets " (2)", " (3)"...), then the bytes over the reservation. */
async function saveFiles(
  agent: SandboxRuntime,
  display: Display,
  agentId: string,
  files: Array<{ name: string; bytes: Uint8Array }>,
): Promise<Array<{ name: string; path: string }>> {
  const reserve = files.map(({ name }) => {
    const { stem, ext } = splitName(safeFileName(name));
    return `reserve ${shq(stem)} ${shq(ext)}`;
  });
  const script = [
    `D=${shq(downloadsDir(agentId))}; mkdir -p -- "$D"`,
    'reserve() { t="$D/$1$2"; n=2; while [ -e "$t" ]; do t="$D/$1 ($n)$2"; n=$((n+1)); done; : > "$t"; printf "%s\\n" "$t"; }',
    ...reserve,
  ].join('\n');
  const result = await display(script);
  const paths = result.stdout.split('\n').filter((line) => line.length > 0);
  if (result.exitCode !== 0 || paths.length !== files.length) {
    throw failed(`could not save the files to Downloads: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  const saved: Array<{ name: string; path: string }> = [];
  for (const [index, path] of paths.entries()) {
    const file = files[index];
    if (file === undefined) break;
    await agent.writeBytes(path, file.bytes);
    saved.push({ name: posix.basename(path), path: posix.relative(agentHome(agentId), path) });
  }
  return saved;
}

/**
 * The image goes to Pictures/Pasted as PNG (JPEG is converted: the clipboard target every app reads is image/png), then xclip
 * forks to own the CLIPBOARD selection. The check waits until the selection really offers image/png, so the Ctrl+V that
 * follows the response cannot paste an older clipboard.
 */
async function imageToClipboard(
  agent: SandboxRuntime,
  display: Display,
  agentId: string,
  image: { mimeType: 'image/png' | 'image/jpeg'; bytes: Uint8Array },
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = pastedImagesDir(agentId);
  const png = `${dir}/${stamp}.png`;
  const jpeg = image.mimeType === 'image/jpeg';
  const source = jpeg ? `${dir}/${stamp}.jpg` : png;
  await agent.writeBytes(source, image.bytes);
  const convert = jpeg
    ? `ffmpeg -y -loglevel error -i ${shq(source)} ${shq(png)}; rc=$?; rm -f -- ${shq(source)}; [ "$rc" -eq 0 ] || exit 1`
    : '';
  const result = await display(
    [
      convert,
      `xclip -selection clipboard -t image/png -i ${shq(png)} </dev/null >/dev/null 2>&1`,
      'i=0; until xclip -selection clipboard -o -t TARGETS </dev/null 2>/dev/null | grep -qx image/png; do i=$((i+1)); [ "$i" -ge 25 ] && exit 1; sleep 0.2; done',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );
  if (result.exitCode !== 0) {
    throw failed(`could not put the image on the computer's clipboard: ${(result.stderr || result.stdout).trim().slice(0, 300) || 'xclip did not own the selection'}`);
  }
  return posix.relative(agentHome(agentId), png);
}
