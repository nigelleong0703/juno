/**
 * LOOP-COST1 runtime pricing precedence: one explicit config/env source resolved once in
 * createVomuAgent, used across the bootstrap provider and account-selected runs. Real runtime
 * buildContext (not helper-only): config-priced/env-empty and env-fallback both freeze pricing.
 */
import { createMemoryBlobStore } from '../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createVomuAgent } from '../index.js';
import { loadConfig } from '../index.js';
import { createMemoryStore } from '../testing/store.js';
import { createConnectorCatalog } from '../modules/mcp/catalog.js';
import { RecordingEnqueuer } from '../execution/testing/enqueuer.js';
import { parseModelSnapshot } from '../execution/brain/model-selection.js';

const BASE_URL = 'http://127.0.0.1:1/v1';
const MODEL_ID = 'qa-priced-model';
const API_KEY = 'secret-key-xyz';
const RATES = { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 };
const PRICING_JSON = JSON.stringify([{ baseUrl: BASE_URL, modelId: MODEL_ID, ...RATES }]);

async function snapshotFor(configJson: string | undefined, envJson: string | undefined) {
  const config = loadConfig({
    MODEL_BASE_URL: BASE_URL,
    MODEL_ID,
    MODEL_API_KEY: API_KEY,
    ...(configJson === undefined ? {} : { MODEL_PRICING_JSON: configJson }),
  });
  const agent = await createVomuAgent({
    store: createMemoryStore(), blobs: createMemoryBlobStore(),
    config,
    enqueuer: new RecordingEnqueuer(),
    connectorCatalog: createConnectorCatalog([]),
    env: {
      MODEL_BASE_URL: BASE_URL,
      MODEL_ID,
      ...(envJson === undefined ? {} : { MODEL_PRICING_JSON: envJson }),
    },
  });
  const ctx = await agent.brain.buildContext({
    agentId: 'missing-agent',
    conversationId: 'c1',
    sessionKey: 'missing-agent:c1',
    wake: [],
  });
  return parseModelSnapshot(ctx);
}

describe('runtime pricing source precedence', () => {
  it('freezes config pricing when env is empty', async () => {
    const snapshot = await snapshotFor(PRICING_JSON, undefined);
    expect(snapshot?.modelId).toBe(MODEL_ID);
    expect(snapshot?.pricing).toEqual(RATES);
    expect(JSON.stringify(snapshot)).not.toContain(API_KEY);
  });

  it('falls back to env pricing when config is empty', async () => {
    const snapshot = await snapshotFor(undefined, PRICING_JSON);
    expect(snapshot?.modelId).toBe(MODEL_ID);
    expect(snapshot?.pricing).toEqual(RATES);
  });

  it('leaves pricing unknown when neither source configures it', async () => {
    const snapshot = await snapshotFor(undefined, undefined);
    expect(snapshot?.modelId).toBe(MODEL_ID);
    expect(snapshot?.pricing).toBeUndefined();
  });
});
