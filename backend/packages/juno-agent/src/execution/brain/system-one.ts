// The System One model: the account's typed-decision model (BACKEND §10.14). One resolver for every caller.
import { settingsIdFor } from '@agent-desktop/public-contracts';
import type { EffectiveFastModel, EffectiveSystemOneModel } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { readStoredModelSettings } from './model-runtime-settings.js';
import type { JevEndpoint } from './system-one-jev.js';
import { openProviderKey, readOwnedProvider } from './user-providers.js';

export interface SystemOneSelection {
  source: 'chosen' | 'platform';
  /** The owner's provider; null for the platform's endpoint. */
  providerId: string | null;
  /** Holds the key: used to make the call, never serialized (see `describeSystemOne`). */
  endpoint: JevEndpoint;
}

/** Order: the owner's chosen System One model, then the platform's endpoint. Undefined when neither applies (then the fast model emulates). */
export async function resolveSystemOne(store: Store, ownerId: string, platform: JevEndpoint | undefined): Promise<SystemOneSelection | undefined> {
  const stored = readStoredModelSettings(await store.get('settings', settingsIdFor(ownerId)));
  const pick = stored.kind === 'controls' ? stored.controls.systemOneModel : undefined;
  if (pick !== undefined) {
    try {
      const record = await readOwnedProvider(store, ownerId, pick.providerId);
      if (record?.kind === 'systemone' && record.baseUrl !== undefined && record.apiKey !== '' && record.models?.includes(pick.modelId) === true) {
        return { source: 'chosen', providerId: record.id, endpoint: { baseUrl: record.baseUrl, apiKey: openProviderKey(record.apiKey), modelId: pick.modelId } };
      }
    } catch {
      // An unreadable key or provider falls through to the next step.
    }
  }
  return platform === undefined ? undefined : { source: 'platform', providerId: null, endpoint: platform };
}

/** The public description: a resolved System One model, else the fast model emulating it, else null. */
export function describeSystemOne(selection: SystemOneSelection | undefined, fast: EffectiveFastModel | null): EffectiveSystemOneModel | null {
  if (selection !== undefined) return { providerId: selection.providerId, modelId: selection.endpoint.modelId, source: selection.source };
  return fast === null ? null : { providerId: fast.providerId, modelId: fast.modelId, source: 'fast-model-emulation' };
}

/** The platform's System One endpoint (SYSTEM_ONE_*), or undefined unless both the base URL and key are set. The model id defaults to `jev-latest`. */
export function readSystemOneEnv(config: Partial<Record<'SYSTEM_ONE_BASE_URL' | 'SYSTEM_ONE_API_KEY' | 'SYSTEM_ONE_MODEL_ID', unknown>>): JevEndpoint | undefined {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const baseUrl = text(config.SYSTEM_ONE_BASE_URL);
  const apiKey = text(config.SYSTEM_ONE_API_KEY);
  return baseUrl === '' || apiKey === '' ? undefined : { baseUrl, apiKey, modelId: text(config.SYSTEM_ONE_MODEL_ID) || 'jev-latest' };
}
