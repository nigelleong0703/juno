import { z } from 'zod';
import type { PluginRow } from './host.js';

const rowsSchema = z.record(z.string(), z.object({ enabled: z.boolean().optional(), config: z.unknown().optional() }).strict());

/**
 * The plugin rows from `JUNO_PLUGINS`, a JSON object keyed by plugin name:
 * `{"meetings":{"enabled":false}}` or `{"somePlugin":{"config":{"key":"value"}}}`. Unset means every built-in plugin
 * runs with no config. A row that cannot be read stops the boot: silently ignoring an operator's setting is worse.
 */
export function pluginRowsFromEnv(env: NodeJS.ProcessEnv): Record<string, PluginRow> {
  const raw = env['JUNO_PLUGINS']?.trim();
  if (raw === undefined || raw === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error('JUNO_PLUGINS is not valid JSON: ' + (error instanceof Error ? error.message : String(error)), { cause: error });
  }
  const parsed = rowsSchema.safeParse(json);
  if (!parsed.success) throw new Error('JUNO_PLUGINS must be an object of {enabled?, config?} per plugin name: ' + parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; '));
  return parsed.data;
}
