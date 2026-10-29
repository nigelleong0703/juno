import { createHash } from 'node:crypto';
import type { DecisionBinding } from '@agent-desktop/public-contracts';

/** Arguments the harness adds and strips before a tool sees them: they say nothing about what the call does. */
const HARNESS_ARGS: ReadonlySet<string> = new Set(['approval', 'background', 'taskTitle']);

export function stripHarnessArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => !HARNESS_ARGS.has(key)));
}

/** JSON with sorted keys, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([key, entry]) => JSON.stringify(key) + ':' + canonicalJson(entry)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What is hashed into `factsHash`: only what the server verified, plus where it lands. */
export interface BoundFacts {
  money?: unknown;
  recipients?: unknown;
  asAccount?: unknown;
  targets?: unknown;
  platform: string;
}

/**
 * The binding of one reviewed call: the arguments (without the agent's own words), the content that is sent or published,
 * and the verified facts. If any of them differs, the hashes differ and the earlier approval does not cover the call.
 */
export function computeBinding(args: unknown, content: readonly string[], facts: BoundFacts): DecisionBinding {
  const contentDigest = sha256(canonicalJson(content));
  return {
    argsHash: sha256(canonicalJson(stripHarnessArgs(args))),
    contentDigest,
    factsHash: sha256(canonicalJson({ ...facts, contentDigest })),
  };
}
