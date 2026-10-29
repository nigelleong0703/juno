import { BUILTIN_CATALOG_ENTRIES } from '@agent-desktop/contracts/mcp';
import { withGatewayScopes } from '../modules/connector-catalog.js';

/** The catalog agentd serves with the `connectors-builtin` plugin active, as the gateway sees it (hosted scopes added). Tests pin it with `connectorCatalog`. */
export const CONNECTOR_CATALOG = withGatewayScopes(BUILTIN_CATALOG_ENTRIES);
