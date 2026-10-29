/**
 * Pure helpers shared by the bounded coding file tools (files.read range/limits, files.edit,
 * files.search). Nothing here touches a sandbox: the callers pass in text and get back text,
 * so a range, a truncation boundary and a shell quote are all decided by testable functions.
 */

import { createHash } from 'node:crypto';

/** Output ceilings. A read or search never dumps an unbounded file or command result at the model. */
export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 2_000;
export const MAX_READ_BYTES = 64 * 1024;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_RESULTS = 500;
export const MAX_SEARCH_BYTES = 64 * 1024;

export interface ByteSlice {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** The exact identity of the bytes a caller read, so an edit can refuse a stale replacement. */
export function contentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

/** Replace the single occurrence at `index` without re-scanning (used after a uniqueness check). */
export function replaceOnce(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  if (index < 0) return content;
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

export interface ReadWindowOptions {
  startLine: number;
  /** Byte offset inside `startLine`; lets a caller resume midway through one very long line. */
  lineOffset: number;
  maxLines: number;
  maxBytes: number;
}

/**
 * A byte-exact window of a file. `endLine` counts only FULLY delivered lines and the continuation
 * (`nextStartLine` + `nextLineOffset`) always names the first byte NOT delivered, so paging through
 * a file never skips or duplicates content — including when a single line is longer than `maxBytes`
 * (then `endLine` is null and the continuation stays on the same line at a byte offset).
 */
export interface ReadWindow {
  text: string;
  startLine: number;
  startLineOffset: number;
  endLine: number | null;
  nextStartLine: number | null;
  nextLineOffset: number;
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
}

export function readWindow(content: string, options: ReadWindowOptions): ReadWindow {
  const buf = Buffer.from(content, 'utf8');
  const totalBytes = buf.length;
  const starts = lineStarts(buf);
  const totalLines = content.endsWith('\n') && totalBytes > 0 ? starts.length - 1 : starts.length;
  const startLine = Math.max(1, Math.min(Math.trunc(options.startLine), Math.max(1, totalLines)));
  const lineStart = starts[startLine - 1] ?? 0;
  const startLineOffset = Math.max(0, Math.trunc(options.lineOffset));
  const from = Math.min(lineStart + startLineOffset, totalBytes);
  const lineWindowEnd = starts[startLine - 1 + Math.max(1, Math.trunc(options.maxLines))] ?? totalBytes;
  let take = Math.max(0, Math.min(options.maxBytes, lineWindowEnd - from, totalBytes - from));
  take = codePointFloor(buf, from, take);
  // A caller can land exactly on a line boundary with nothing left in the line window; deliver one
  // code point so the cursor always advances and paging cannot loop on an empty window.
  if (take === 0 && from < totalBytes) take = firstCodePointBytes(buf, from);
  const completeLines = countNewlines(buf, from, take);
  const truncated = from + take < totalBytes;
  const resumeLine = startLine + completeLines;
  const resumeStart = truncated ? starts[resumeLine - 1] : undefined;
  return {
    text: buf.subarray(from, from + take).toString('utf8'),
    startLine,
    startLineOffset,
    endLine: completeLines > 0 ? startLine + completeLines - 1 : null,
    nextStartLine: truncated ? resumeLine : null,
    nextLineOffset: truncated && resumeStart !== undefined ? from + take - resumeStart : 0,
    totalLines,
    totalBytes,
    truncated,
  };
}

function lineStarts(buf: Buffer): number[] {
  const starts = [0];
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) starts.push(i + 1);
  return starts;
}

function countNewlines(buf: Buffer, from: number, length: number): number {
  let count = 0;
  for (let i = from; i < from + length; i += 1) if (buf[i] === 0x0a) count += 1;
  return count;
}

/** Back a byte budget off to a UTF-8 code-point boundary so a multi-byte character is never split. */
function codePointFloor(buf: Buffer, from: number, take: number): number {
  let end = take;
  while (end > 0) {
    const byte = buf[from + end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return end;
}

function firstCodePointBytes(buf: Buffer, from: number): number {
  const lead = buf[from];
  if (lead === undefined) return 0;
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Cap output by UTF-8 bytes on a code-point boundary so a multi-byte character is never split. */
export function truncateBytes(text: string, maxBytes: number): ByteSlice {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  let end = maxBytes;
  while (end > 0) {
    const byte = buf.subarray(end, end + 1)[0];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return { text: buf.subarray(0, end).toString('utf8'), bytes, truncated: true };
}

/**
 * Wrap one value as a POSIX shell single-quoted word. Single quotes neutralize every metacharacter
 * (command substitution, redirection, globbing), and an embedded quote is escaped as `'\''`.
 */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}
