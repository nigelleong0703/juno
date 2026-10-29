/** App-owned public routes: settings, integrations, library and activity. */
import type { Hono } from 'hono';
import type { BlobStore, Store } from '@agent-desktop/contracts';
import type { ModelCatalogLoader, SettingsUpdater } from '../modules/settings.js';
import { registerSettings } from './settings.js';
import { registerPlugins } from './plugins.js';
import { registerLibrary } from './library.js';
import { registerArtifacts } from './artifacts.js';
import { registerSpaces, type SpaceRoutesDeps } from './spaces.js';
import { registerAudit } from './audit.js';
import { registerUsage } from './usage.js';
import { registerRoutineWebhook } from './hooks.js';
import { registerAppsInstall } from './apps.js';
import type { ConnectorsDeps } from '../modules/connectors.js';
import { registerModelProviderRoutes } from './model-providers.js';
import type { ModelProviderCatalogClient } from '../modules/model-providers.js';

export interface AppRoutesDeps {
  store: Store;
  /** Where file bytes live (uploads, downloads, artifact files). */
  blobs: BlobStore;
  /** Production durable settings writer; absent uses the in-process store transaction. */
  settingsUpdater?: SettingsUpdater;
  /** Authoritative model catalog for validating non-null model choices; absent fails closed. */
  modelsLoader?: ModelCatalogLoader;
  /** Public gateway base URL for absolute webhook URLs. */
  publicUrl?: string;
  /** Adding and removing work and custom apps (the OAuth connect flow and the connector catalog); absent leaves the install routes to agentd, which refuses them. */
  connectors?: ConnectorsDeps;
  /** Built-in provider list and provider catalogs (agentd); absent leaves the provider routes unmapped. */
  providerClient?: ModelProviderCatalogClient;
  /** The platform default endpoint is configured. */
  platformDefault?: boolean;
  /** Where HTML artifacts are served from and the key that signs their URLs; absent leaves render-url unavailable (503). */
  artifactOrigin?: { origin: string; secret: string };
  /** Spaces preview origin settings (SPACE_DOMAIN, key, computerd); absent leaves the space routes unmapped. */
  spaces?: SpaceRoutesDeps;
  /** Transport for the ChatGPT sign-in token exchange; absent uses the global fetch. */
  oauthFetch?: typeof fetch;
}

export function registerAppRoutes(app: Hono, deps: AppRoutesDeps): void {
  registerSettings(app, deps);
  if (deps.providerClient) registerModelProviderRoutes(app, { store: deps.store, providerClient: deps.providerClient, platformDefault: deps.platformDefault ?? false, ...(deps.oauthFetch ? { oauthFetch: deps.oauthFetch } : {}) });
  registerPlugins(app, deps);
  registerLibrary(app, deps);
  registerArtifacts(app, deps);
  if (deps.spaces) registerSpaces(app, { ...deps, spaces: deps.spaces });
  registerAudit(app, deps);
  registerUsage(app, deps);
  registerRoutineWebhook(app, deps);
  if (deps.connectors) registerAppsInstall(app, deps.connectors);
}
