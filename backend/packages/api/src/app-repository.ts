/**
 * App-owned data boundary for the public API.
 *
 * Composition only: the owner scope is derived once here and handed to one narrow module per
 * feature. Each module owns its collections, so a route cannot reach agent lifecycle rows or
 * another owner's data, and the ownership of settings/integrations/library/activity stays legible.
 */
import type { BlobStore, Store } from '@agent-desktop/contracts';
import type { ModelProviderCatalogClient } from './modules/model-providers.js';
import { createActivityModule, type ActivityModule } from './modules/activity.js';
import { createIntegrationsModule, type IntegrationsModule } from './modules/integrations.js';
import { createArtifactsModule, type ArtifactsModule } from './modules/artifacts.js';
import { createLibraryModule, type LibraryModule } from './modules/library.js';
import {
  createSettingsModule,
  type ModelCatalogLoader,
  type SettingsModule,
  type SettingsUpdater,
} from './modules/settings.js';

export interface AppRepository {
  settings: SettingsModule;
  integrations: IntegrationsModule;
  library: LibraryModule;
  artifacts: ArtifactsModule;
  activity: ActivityModule;
}

/** Owner-scoped Store view; account data must never fall back to the raw store. */
function ownerScopedStore(store: Store, ownerId: string): Store {
  if (typeof store.forOwner !== 'function') {
    throw new Error('Store.forOwner is required: refusing unscoped app data access');
  }
  return store.forOwner(ownerId);
}

export function createAppRepository(
  store: Store,
  blobs: BlobStore,
  ownerId: string,
  settingsUpdater?: SettingsUpdater,
  modelsLoader?: ModelCatalogLoader,
  providers?: ModelProviderCatalogClient,
): AppRepository {
  const scoped = ownerScopedStore(store, ownerId);
  return {
    settings: createSettingsModule(scoped, ownerId, settingsUpdater, modelsLoader, providers),
    integrations: createIntegrationsModule(scoped, ownerId),
    library: createLibraryModule(scoped, blobs),
    artifacts: createArtifactsModule(scoped, blobs),
    activity: createActivityModule(scoped),
  };
}
