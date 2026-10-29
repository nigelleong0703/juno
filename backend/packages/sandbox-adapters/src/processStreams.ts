/**
 * Bounded, code-point-safe windowing of one process stream (stdout or stderr). Kept apart from the
 * process seam so both streams share one lossless read rule: a cursor never advances past a partial
 * character, and growth past the window is reported as truncated rather than silently cut.
 */
import type { SandboxRuntime } from './runtime.js';
import { failed } from './errors.js';

export interface StreamSlice {
  text: string;
  cursor: number;
  truncated: boolean;
}
export function emptySlice(cursor: number): StreamSlice {
  return { text: '', cursor, truncated: false };
}

/** One bounded, code-point-safe window of one stream; growth past the window is reported as truncated. */
export async function readStream(runtime: SandboxRuntime, path: string, cursor: number, maxBytes: number, total: number): Promise<StreamSlice> {
  const bytes = await readBytes(runtime, path);
  const complete = completeBytes(bytes);
  const next = cursor + complete;
  return { text: Buffer.from(bytes.subarray(0, complete)).toString('utf8'), cursor: next, truncated: next < total };
}

/** Read the bounded slice; a read failure is reported truthfully, never as empty output. */
async function readBytes(runtime: SandboxRuntime, path: string): Promise<Uint8Array> {
  try {
    return await runtime.readBytes(path);
  } catch (error) {
    throw failed('could not read the process output from the sandbox: ' + (error instanceof Error ? error.message : String(error)));
  }
}

/** Largest prefix that ends on a UTF-8 code-point boundary; an incomplete tail returns its lead index. */
function completeBytes(bytes: Uint8Array): number {
  let index = bytes.length - 1;
  while (index >= 0 && ((bytes[index] ?? 0) & 0xc0) === 0x80) index -= 1;
  if (index < 0) return 0;
  const lead = bytes[index] ?? 0;
  const size = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return index + size <= bytes.length ? bytes.length : index;
}
