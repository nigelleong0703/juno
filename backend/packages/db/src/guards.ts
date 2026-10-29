/**
 * Runtime narrowing for values that cross the Postgres boundary.
 *
 * jsonb arrives from the driver as `unknown`, and `Store.put` receives the generic `Doc<C>`. These
 * guards let the store recover the typed shapes without `as` assertions: the driver already parses
 * jsonb into plain objects, so validation is a structural check, not a parse.
 */
import type { AgentEvent } from '@agent-desktop/public-contracts';
import type { Collection, Doc } from '@agent-desktop/contracts';

/** A plain-JSON value the driver can serialize into a jsonb column. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Documents handed to the store are always plain objects. */
export function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError('expected a plain object document');
  }
  return value;
}

/**
 * Validate a value down to plain JSON (objects, arrays, primitives), the shape jsonb accepts.
 * Mirrors `JSON.stringify` semantics: `Date` becomes an ISO string, unsupported values are dropped
 * inside objects and become `null` inside arrays. Returns `undefined` for values with no JSON form.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  // jsonb rejects U+0000 anywhere in a string; one NUL byte in a tool's output (a binary file read as text)
  // would otherwise fail the write and the run with it. It becomes U+FFFD, the replacement character.
  if (typeof value === 'string') {
    return value.includes('\u0000') ? value.replaceAll('\u0000', '\uFFFD') : value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item) ?? null);
  }
  if (isRecord(value)) {
    const out: { [key: string]: JsonValue | undefined } = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  return undefined;
}

/** Every stored document carries a string `id`; that is enough to recover `Doc<C>` on read. */
export function isDoc<C extends Collection>(value: unknown): value is Doc<C> {
  return isRecord(value) && typeof value['id'] === 'string';
}

export function readString(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === 'string' ? value : undefined;
}

/** Event payloads are written through `Store.emit(event: AgentEvent)`; the log is the source of truth. */
export function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value['type'] === 'string';
}
