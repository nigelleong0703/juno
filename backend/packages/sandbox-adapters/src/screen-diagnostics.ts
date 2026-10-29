/**
 * Diagnostics and small pure helpers for screen boot: the operator message the provider surfaces
 * when a display does not come up, plus the pointer-command and PNG-size helpers the action runner
 * and the file reader share. Extracted from `screen-boot.ts` and re-exported there so existing
 * callers and tests keep their import path and behavior.
 */
import type { Point, ScrollInput } from './types.js';
import { modelToScreenShell } from './model-screen.js';

/**
 * Why a display failed to boot: the exit code plus BOTH output streams, so the program's own stdout
 * diagnostic is never hidden behind shell stderr. Each stream is redacted before it is bounded, so a
 * truncated log can neither carry a VNC password nor crowd out the other stream.
 */
export function screenStartFailure(displayNo: number, cause: unknown, secrets: readonly string[]): string {
  const exit = commandExit(cause);
  const code = exit ? ` (exit ${exit.exitCode})` : '';
  const detail = exit ? bothStreams(exit, secrets) : redact(message(cause), secrets);
  return bound(redact(`screen :${displayNo} failed to start${code}: ${detail}`, secrets), 2000);
}

/** Both streams, redacted then bounded; a lone non-empty stream stays unlabelled. */
function bothStreams(exit: { stdout: string; stderr: string }, secrets: readonly string[]): string {
  const stdout = redact(exit.stdout, secrets).trim();
  const stderr = redact(exit.stderr, secrets).trim();
  if (stdout === '' || stderr === '') return stdout || stderr || 'no output';
  return `stdout: ${bound(stdout, 800)} stderr: ${bound(stderr, 800)}`;
}

/** A thrown value's exit result (E2B CommandExitError shape); `instanceof` is unreliable across the CJS/ESM split. */
function commandExit(error: unknown): { exitCode: number; stdout: string; stderr: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('exitCode' in error) || !('stdout' in error) || !('stderr' in error)) return undefined;
  const { exitCode, stdout, stderr } = error;
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) return undefined;
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return undefined;
  return { exitCode, stdout, stderr };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const bound = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

function redact(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text;
}

/** A click at model coordinates (the screenshot's pixels), mapped to the framebuffer in the same command. */
export function xdotoolClick(point: Point, button: number, repeat: number): string {
  const repeatFlag = repeat > 1 ? ` --repeat ${repeat} --delay 100` : '';
  return `${modelToScreenShell(point.x, point.y)}; xdotool mousemove --sync "$1" "$2" click${repeatFlag} ${button}`;
}

/** A pointer move at model coordinates. */
export function xdotoolMove(point: Point): string {
  return `${modelToScreenShell(point.x, point.y)}; xdotool mousemove --sync "$1" "$2"`;
}

export function xdotoolScroll(input: ScrollInput): string {
  const button = input.deltaY >= 0 ? 5 : 4;
  const count = Math.max(1, Math.floor(Math.abs(input.deltaY) / 100) || 1);
  const horizontal = input.deltaX ?? 0;
  const hFlag =
    horizontal === 0
      ? ''
      : ` && xdotool click --repeat ${Math.max(1, Math.floor(Math.abs(horizontal) / 100) || 1)} ${horizontal >= 0 ? 7 : 6}`;
  return `xdotool click --repeat ${count} ${button}${hFlag}`;
}

/**
 * Mime type and size of a captured image, read from its own header (PNG IHDR, JPEG SOF marker); the
 * bytes decide, not the file name, so a capture that fell back to PNG is described truthfully.
 */
export function imageInfo(bytes: Uint8Array): { mimeType: 'image/png' | 'image/jpeg'; width: number; height: number } {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xff) { at += 1; continue; }
      const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { mimeType: 'image/jpeg', height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0), width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0) };
      at += 2 + length;
    }
    return { mimeType: 'image/jpeg', width: 0, height: 0 };
  }
  return { mimeType: 'image/png', ...pngSize(bytes) };
}

/** Width/height straight from the PNG IHDR so we never shell out to an image tool. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return { width: 0, height: 0 };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
