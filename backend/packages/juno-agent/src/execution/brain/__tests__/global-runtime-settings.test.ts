/**
 * Account-global model runtime controls: the owner's reasoning/temperature/output choices are read
 * once per run, qualified against what the gateway catalog actually advertises, and frozen on the
 * journaled snapshot so steering or a later settings change never moves a running run's provider
 * parameters. Two agents of one account share the same controls; owners stay isolated.
 */
import { describe, expect, it } from 'vitest';
import { TerminalError } from '@agent-desktop/durable';
import { ModelSelectionError, parseModelSnapshot, toTerminalModelError } from '../model-selection.js';
import { createModelCatalogLoader } from '../model-catalog.js';
import { readStoredModelSettings } from '../model-runtime-settings.js';
import {
  ENV,
  REASONER,
  UPSTREAM_DOC,
  buildFor,
  failingFetch,
  setup,
  type Fixture,
} from './runtime-settings-fixture.js';

async function failureOf(fixture: Fixture, ownerId = 'owner-1'): Promise<ModelSelectionError> {
  const failure: unknown = await buildFor(fixture, ownerId, 'a1').then(
    () => null,
    (error: unknown) => error,
  );
  if (!(failure instanceof ModelSelectionError)) throw new Error('expected a ModelSelectionError');
  return failure;
}

describe('account-global model runtime controls', () => {
  it('freezes the controls onto the snapshot for every agent of the same owner', async () => {
    const fixture = await setup();
    await fixture.setModels('owner-1', REASONER);
    const first = await buildFor(fixture, 'owner-1', 'a1');
    const second = await buildFor(fixture, 'owner-1', 'a2');
    expect(parseModelSnapshot(first)).toEqual({
      modelId: 'reasoner',
      baseUrl: ENV.baseUrl,
      supportsImages: false,
      controls: { reasoningEffort: 'high', temperature: 0.2, maxOutputTokens: 300 },
    });
    expect(parseModelSnapshot(second)).toEqual(parseModelSnapshot(first));
    await fixture.brain.step(first, [], { signal: new AbortController().signal });
    await fixture.brain.step(second, [], { signal: new AbortController().signal });
    const expected = { modelId: 'reasoner', controls: { reasoningEffort: 'high', temperature: 0.2, maxOutputTokens: 300 } };
    expect(fixture.bound).toEqual([expected, expected]);
    // The resolved endpoint is journaled; the credential never is.
    expect(JSON.stringify(parseModelSnapshot(first))).not.toContain(ENV.apiKey);
  });

  it('a mid-run settings change never reaches the running run provider parameters', async () => {
    const fixture = await setup();
    await fixture.setModels('owner-1', REASONER);
    const frozen = await buildFor(fixture, 'owner-1', 'a1');
    expect(fixture.resolveCount()).toBe(1);
    await fixture.setModels('owner-1', { defaultModel: 'plain', tiers: { chat: { effort: 'low' } }, temperature: 1.5 });
    await fixture.brain.step(frozen, [], { signal: new AbortController().signal });
    // A steering rebuild carries the same journaled controls instead of re-reading settings.
    const steered = await buildFor(fixture, 'owner-1', 'a1', frozen);
    await fixture.brain.step(steered, [], { signal: new AbortController().signal });
    expect(fixture.resolveCount()).toBe(1);
    expect(parseModelSnapshot(steered)).toEqual(parseModelSnapshot(frozen));
    const expected = { modelId: 'reasoner', controls: { reasoningEffort: 'high', temperature: 0.2, maxOutputTokens: 300 } };
    expect(fixture.bound).toEqual([expected, expected]);
  });

  it('rejects a reasoning effort the chosen model does not advertise', async () => {
    const fixture = await setup();
    await fixture.setModels('owner-1', { defaultModel: 'reasoner', tiers: { chat: { effort: 'max' } } });
    const failure = await failureOf(fixture);
    expect(failure.code).toBe('unsupported-reasoning');
    expect(failure.message).toContain('max');
    expect(toTerminalModelError(failure)).toBeInstanceOf(TerminalError);
  });

  it('rejects a reasoning effort for a model described as offering none', async () => {
    const fixture = await setup();
    await fixture.setModels('owner-1', { defaultModel: 'plain', tiers: { chat: { effort: 'low' } } });
    expect((await failureOf(fixture)).code).toBe('unsupported-reasoning');
  });

  it('fails loudly when the catalog cannot confirm the requested reasoning effort', async () => {
    const fixture = await setup(failingFetch);
    await fixture.setModels('owner-1', { defaultModel: null, tiers: { chat: { effort: 'high' } }, temperature: 0.4 });
    const failure = await failureOf(fixture);
    expect(failure.code).toBe('unverified-reasoning');
    expect(failure.message).toContain('did not describe its reasoning support');
    expect(toTerminalModelError(failure)).toBeInstanceOf(TerminalError);
  });

  it('still applies the other controls when no reasoning effort is requested', async () => {
    const fixture = await setup(failingFetch);
    await fixture.setModels('owner-1', { defaultModel: null, temperature: 0.4, maxOutputTokens: 700 });
    const context = await buildFor(fixture, 'owner-1', 'a1');
    expect(parseModelSnapshot(context)?.modelId).toBe(ENV.modelId);
    expect(parseModelSnapshot(context)?.controls).toEqual({ omitReasoning: true, temperature: 0.4, maxOutputTokens: 700 });
    await fixture.brain.step(context, [], { signal: new AbortController().signal });
    expect(fixture.bound[0]?.controls).toEqual({ omitReasoning: true, temperature: 0.4, maxOutputTokens: 700 });
  });

  it('a legacy row without a controls section sends no reasoning on Responses when the catalog is silent', async () => {
    const fixture = await setup();
    await fixture.setLegacy('owner-1');
    const context = await buildFor(fixture, 'owner-1', 'a1');
    expect(parseModelSnapshot(context)).toEqual({ modelId: ENV.modelId, baseUrl: ENV.baseUrl, supportsImages: false, controls: { omitReasoning: true } });
    await fixture.brain.step(context, [], { signal: new AbortController().signal });
    expect(fixture.bound).toEqual([{ modelId: ENV.modelId, controls: { omitReasoning: true } }]);
  });

  it('a models row with an invalid control fails explicitly instead of dropping it', async () => {
    expect(readStoredModelSettings({ models: { defaultModel: 'reasoner', temperature: 9 } })).toEqual({ kind: 'invalid' });
    expect(readStoredModelSettings({ models: null })).toEqual({ kind: 'absent' });
    expect(readStoredModelSettings({ models: { defaultModel: 'reasoner', temperature: 'hot' } })).toEqual({ kind: 'invalid' });
    const fixture = await setup();
    const corrupt = JSON.parse(JSON.stringify({ id: 'app-settings-owner-1', models: { defaultModel: 'reasoner', temperature: 9 } }));
    await fixture.store.put('settings', corrupt);
    expect((await failureOf(fixture)).code).toBe('invalid-model');
  });

  it('offers only pi-ai levels, and distinguishes undescribed from explicitly none', async () => {
    const catalog = await createModelCatalogLoader(ENV, async () =>
      new Response(JSON.stringify(UPSTREAM_DOC), { headers: { 'content-type': 'application/json' } }),
    ).load();
    const byId = new Map(catalog.catalog.items.map((item) => [item.id, item]));
    expect(byId.get('reasoner')?.reasoningEfforts).toEqual(['low', 'high']);
    expect(byId.get('plain')?.reasoningEfforts).toEqual([]);
    expect(byId.get('quiet')?.reasoningEfforts).toBeUndefined();
    expect(byId.get('env-default')?.reasoningEfforts).toBeUndefined();
    expect('reasoningEfforts' in (byId.get('quiet') ?? {})).toBe(false);
  });
});
