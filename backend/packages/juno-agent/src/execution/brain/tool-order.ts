/**
 * Stable tools array. Tools sit at the very front of the prompt, so their order must never move:
 * the session persists the order it first saw, a tool that appears later (a new built-in, an MCP
 * server or plugin the agent connected) is appended at the end in the order it was discovered, and
 * a tool that disappears is dropped (one deliberate prefix reset). Discovery order never reshuffles
 * what was already delivered.
 */

/** Persisted order merged with the names discovered now: survivors keep their slot, newcomers go last. */
export function mergeToolOrder(persisted: readonly string[] | undefined, discovered: readonly string[]): string[] {
  const present = new Set(discovered);
  const kept = (persisted ?? []).filter((name, index, all) => present.has(name) && all.indexOf(name) === index);
  const known = new Set(kept);
  return [...kept, ...discovered.filter((name) => !known.has(name) && (known.add(name), true))];
}

/** The tools in the persisted order; names not in it follow in the order given. */
export function orderTools<T extends { name: string }>(tools: readonly T[], order: readonly string[] | undefined): T[] {
  if (order === undefined || order.length === 0) return [...tools];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const ordered: T[] = [];
  for (const name of order) {
    const tool = byName.get(name);
    if (tool !== undefined) {
      ordered.push(tool);
      byName.delete(name);
    }
  }
  return [...ordered, ...byName.values()];
}
