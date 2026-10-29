/**
 * The built-in connector catalog as a first-party plugin: it registers the entries in juno-agent's
 * `BUILTIN_CATALOG_ENTRIES` through `ctx.connectors.register`, the same path any other plugin's connectors take.
 * Boot builds the one `ConnectorCatalog` from whatever the loaded plugins registered. Turn the built-ins off with
 * `JUNO_PLUGINS={"connectors-builtin":{"enabled":false}}`: search stops listing them, connect is refused, and an
 * owner's existing connections to them are shown unavailable and not used (the rows stay).
 */
import { BUILTIN_CATALOG_ENTRIES } from 'juno-agent/modules/mcp/catalog';
import type { AgentdPlugin } from '../plugins/services.js';

export const connectorsBuiltinPlugin: AgentdPlugin = {
  name: 'connectors-builtin',
  apply(ctx) {
    for (const entry of BUILTIN_CATALOG_ENTRIES) ctx.connectors.register(entry);
  },
};
