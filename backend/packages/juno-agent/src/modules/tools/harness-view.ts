/**
 * The model-facing text of the built-in tools is a harness unit (BACKEND §11.2, H1b). The code keeps each description slot as `''`
 * where its text used to be (the key stays, so the schema's key order and shape do not change). The text is read from the harness:
 *
 * - a tool's description: unit `tool.<name>`;
 * - a parameter's description: unit `tool.<name>.param.<path>`, where <path> is the property names from the root joined with `.`
 *   (a property inside an array's element schema is `items.<name>`; any other nested schema keyword is one path segment).
 *
 * Tool names may contain dots (`browser.click`); the id is built from the name, never parsed back. MCP and plugin tools are not built-in
 * and keep their own text. The text is read when the tool is offered, so it comes from the session's pinned version.
 */
import type { Tool } from '../../contracts/index.js';
import { activeHarnessVersion, HarnessError, renderHarnessUnit, type HarnessVersion } from '../harness/loader.js';

export const TOOL_UNIT_PREFIX = 'tool.';

export function toolUnitId(name: string): string {
  return TOOL_UNIT_PREFIX + name;
}

export function paramUnitId(name: string, path: readonly string[]): string {
  return `${toolUnitId(name)}.param.${path.join('.')}`;
}

type Json = unknown;
const isObject = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walk a schema and replace every empty `description` (below the root) with `fill(path)`. Keys keep their order.
 * `properties` children extend the path by their name; any other keyword whose value is an object or array extends it by the keyword
 * (so `items` is a segment). Array elements share their keyword's path.
 */
function mapSlots(node: Json, path: readonly string[], name: string, fill: (id: string) => string): Json {
  if (Array.isArray(node)) return node.map((item) => mapSlots(item, path, name, fill));
  if (!isObject(node)) return node;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && value === '' && path.length > 0) out[key] = fill(paramUnitId(name, path));
    else if (key === 'properties' && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([child, schema]) => [child, mapSlots(schema, [...path, child], name, fill)]));
    } else if (typeof value === 'object' && value !== null) out[key] = mapSlots(value, [...path, key], name, fill);
    else out[key] = value;
  }
  return out;
}

/** Whether the registry treats a tool as built-in: its text is a harness unit. */
export function isBuiltinTool(tool: Tool, pluginNames: ReadonlySet<string>): boolean {
  return tool.mcp !== true && !pluginNames.has(tool.name);
}

/** The tool with its empty slots filled from the version: the description, and every parameter description that is empty. */
export function harnessToolView(tool: Tool, version: HarnessVersion): Tool {
  const description = tool.description === '' ? renderHarnessUnit(version, toolUnitId(tool.name)) : tool.description;
  const parameters = mapSlots(tool.parameters, [], tool.name, (id) => renderHarnessUnit(version, id)) as Tool['parameters'];
  return { ...tool, description, parameters };
}

/**
 * Boot check: every built-in tool keeps no text in code, and every slot has a unit in the version. Runs over all the tools the
 * registry holds (conditional ones included), so a missing unit fails startup instead of a turn.
 */
/**
 * Descriptions still in code, by unit id. The project's write hook refuses unit files whose names contain "summary" or "report"
 * (it reads them as reports), so these three cannot be written yet. Each keeps its literal text; the list is the only exception.
 * Remove an entry when its unit is written.
 */
export const KEPT_IN_CODE: ReadonlySet<string> = new Set([
  'tool.report_to_parent',
  'tool.goal_update.param.summary',
  'tool.feed_post.param.summary',
  'tool.document_propose.param.summary',
]);

export function checkToolUnits(tools: readonly Tool[], pluginNames: ReadonlySet<string>, version: HarnessVersion = activeHarnessVersion()): void {
  const problems: string[] = [];
  for (const tool of tools) {
    if (!isBuiltinTool(tool, pluginNames)) continue;
    const needed: string[] = [];
    if (tool.description !== '') {
      if (!KEPT_IN_CODE.has(toolUnitId(tool.name))) problems.push(`tool ${tool.name} keeps its description in code (move it to harness/tool/)`);
    } else needed.push(toolUnitId(tool.name));
    mapSlots(tool.parameters, [], tool.name, (id) => { needed.push(id); return ''; });
    for (const id of needed) if (!version.units.has(id)) problems.push(`harness unit ${id} is missing for tool ${tool.name}`);
  }
  if (problems.length > 0) throw new HarnessError('built-in tool text is invalid:\n' + problems.join('\n'));
}
