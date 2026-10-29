/**
 * File bytes in and out, shared by the four platforms: one size cap (the app's own upload cap, so an inbound file lands in the library
 * exactly like an upload) and one download that only ever sends the bot's credentials to the platform's own file host.
 */
import { MAX_UPLOAD_BYTES } from '@agent-desktop/public-contracts';
import type { AdapterResult } from './abilities.js';

/** The largest file in either direction: the app's upload cap (a library file). */
export const MAX_FILE_BYTES = MAX_UPLOAD_BYTES;

const DOWNLOAD_TIMEOUT_MS = 20_000;

export function tooLarge(sizeBytes: number): { status: 'failed'; error: string } {
  return { status: 'failed', error: 'the file is ' + String(sizeBytes) + ' bytes; the limit is ' + String(MAX_FILE_BYTES) };
}

/** GET the bytes of a file. `hosts` is the allowlist the URL must be on; the headers (a bot token) go only to those hosts. */
export async function downloadFile(
  fetchFn: typeof fetch,
  url: string,
  hosts: readonly string[],
  headers: Record<string, string> = {},
): Promise<AdapterResult<{ bytes: Uint8Array; mime?: string }>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'failed', error: 'the file has no valid URL' };
  }
  if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname)) return { status: 'failed', error: 'the file is not on the platform\'s file host' };
  let response: Response;
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    return { status: 'failed', error: 'the file could not be downloaded: ' + (error instanceof Error ? error.message : String(error)) };
  }
  if (!response.ok) return { status: 'failed', error: 'the file could not be downloaded (HTTP ' + String(response.status) + ')' };
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) return tooLarge(declared);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) return tooLarge(bytes.length);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
  return { status: 'ok', value: mime === undefined || mime === '' ? { bytes } : { bytes, mime } };
}

/** The bytes to post, checked against the cap; undefined when they fit. */
export function sizeProblem(bytes: Uint8Array): { status: 'failed'; error: string } | undefined {
  return bytes.length > MAX_FILE_BYTES ? tooLarge(bytes.length) : undefined;
}

/** A multipart body with one file part (the field name the platform documents). */
export function fileForm(fields: Record<string, string>, field: string, file: { name: string; mime: string; bytes: Uint8Array }): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append(field, new Blob([file.bytes], { type: file.mime }), file.name);
  return form;
}
