/**
 * The schema hash of a tool: sha256 over the canonical JSON of {name, parameters} (memory-graph design §7.1). The description is left out on
 * purpose: descriptions change often and must not invalidate a skill; a description change is a separate evaluation signal, not a dependency.
 */
import { createHash } from 'node:crypto';
import type { ToolHashes } from './types.js';

/** JSON with object keys sorted at every depth, so two equal schemas always produce the same bytes. Undefined members are dropped, as JSON does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']';
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]));
  return '{' + members.join(',') + '}';
}

/** sha256 hex of the tool's name and parameter schema. */
export function schemaHash(tool: { name: string; parameters: unknown }): string {
  return createHash('sha256').update(canonicalJson({ name: tool.name, parameters: tool.parameters })).digest('hex');
}

/** The lookup the dependency recheck uses: tool name to its current hash, from the tools this process or run can see. */
export function toolHashes(tools: Iterable<{ name: string; parameters: unknown }>): ToolHashes {
  const hashes = new Map<string, string>();
  for (const tool of tools) hashes.set(tool.name, schemaHash(tool));
  return (name) => hashes.get(name);
}
