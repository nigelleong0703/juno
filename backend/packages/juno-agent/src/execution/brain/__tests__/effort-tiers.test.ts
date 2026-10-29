/**
 * Reasoning-effort tiers: the tier -> effort mapping per model, the lane -> tier table, and the effort frozen on the run's
 * model snapshot (the prompt cache is keyed per effort, so it must never move inside a conversation).
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { appSettingsSchema, settingsIdFor } from '@agent-desktop/public-contracts';
import type { ModelCatalogItem, Run, Tiers } from '@agent-desktop/public-contracts';
import type { Store, WakeEvent } from '../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { childSessionKey } from '../../../modules/tasks/childRead.js';
import { createBrain } from '../index.js';
import { backendConfigSchema } from '../../config.js';
import { builtinCatalogItem, findBuiltinModel } from '../builtin-providers.js';
import { toCatalogItem } from '../model-catalog-fields.js';
import { createAccountModelSelection, parseModelSnapshot } from '../model-selection.js';
import { effortForTier, tierForLane, type EffortTier } from '../reasoning-tier.js';
import { freezeRuntimeControls } from '../model-runtime-settings.js';
import { sealProviderKey } from '../user-providers.js';

function builtin(providerId: string, modelId: string): ModelCatalogItem {
  const model = findBuiltinModel(providerId, modelId);
  if (model === undefined) throw new Error('model missing from the pi-ai catalog: ' + modelId);
  return builtinCatalogItem(model);
}

const tiers = (item: ModelCatalogItem, wire = 'openai-responses') =>
  (['quick', 'standard', 'deep'] as const).map((tier) => effortForTier(tier, item, wire));
const levels = (...efforts: string[]) => efforts.map((effort) => (effort === 'none' ? { kind: 'none' } : { kind: 'effort', effort }));

describe('tier -> effort per model', () => {
  it('Muse Spark has no none: quick is minimal', () => {
    expect(tiers(builtin('opencode-go', 'muse-spark-1.3-contributor'))).toEqual(levels('minimal', 'low', 'high'));
  });
  it('Luna has none and no minimal: quick leaves the level out on Responses', () => {
    for (const item of [builtin('openai', 'gpt-6-luna'), builtin('openai', 'gpt-5.6-luna'), builtin('opencode-go', 'gpt-5.6-luna')]) {
      expect(tiers(item)).toEqual(levels('none', 'low', 'high'));
    }
  });
  it('none cannot be sent on chat completions, so quick is the lowest offered level', () => {
    expect(tiers(builtin('openai', 'gpt-6-luna'), 'openai-completions')).toEqual(levels('low', 'low', 'high'));
  });
  it('a model without none or minimal (o3) takes the lowest level for quick', () => {
    expect(tiers(builtin('openai', 'o3'))).toEqual(levels('low', 'low', 'high'));
  });
  it('picks the nearest offered level, the higher one on a tie', () => {
    const item: ModelCatalogItem = { id: 'm', name: 'm', supportsImages: false, reasoningEfforts: ['medium', 'xhigh'] };
    expect(tiers(item)).toEqual(levels('medium', 'medium', 'xhigh'));
  });
  it('a model with no levels, or none described, sends nothing', () => {
    const empty: ModelCatalogItem = { id: 'm', name: 'm', supportsImages: false, reasoningEfforts: [] };
    expect(tiers(empty)).toEqual([{ kind: 'omit' }, { kind: 'omit' }, { kind: 'omit' }]);
    expect(effortForTier('deep', undefined, 'openai-responses')).toEqual({ kind: 'omit' });
  });
  it('measured models get their measured levels even when a gateway publishes a shorter list; others keep the published one', () => {
    const env = { modelId: 'x', supportsImages: false };
    const muse = toCatalogItem({ id: 'opencode-go/muse-spark-1.3-contributor' }, env);
    expect(muse?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(muse?.noReasoning).toBeUndefined();
    const luna = toCatalogItem({ id: 'gpt-6-luna' }, env);
    expect(luna).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], noReasoning: true });
    // OCX lists low..xhigh for Muse Spark; the real API also takes minimal and max, so quick stays minimal.
    const ocxMuse = toCatalogItem({ id: 'opencode-go/muse-spark-1.3-contributor', reasoning_effort: ['low', 'medium', 'high', 'xhigh'] }, env);
    expect(ocxMuse?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const other = toCatalogItem({ id: 'some-other-model', reasoning_effort: ['none', 'low', 'high'] }, env);
    expect(other).toMatchObject({ reasoningEfforts: ['low', 'high'], noReasoning: true });
  });
  it('the platform default with no catalog entry still gets its measured levels', () => {
    const frozen = (modelId: string, tier: EffortTier) => freezeRuntimeControls(undefined, undefined, modelId, 'openai-responses', tier);
    expect(frozen('opencode-go/muse-spark-1.3-contributor', 'quick')).toEqual({ kind: 'frozen', controls: { reasoningEffort: 'minimal' } });
    expect(frozen('opencode-go/muse-spark-1.3-contributor', 'standard')).toEqual({ kind: 'frozen', controls: { reasoningEffort: 'low' } });
    expect(frozen('opencode-go/gpt-5.6-luna', 'deep')).toEqual({ kind: 'frozen', controls: { reasoningEffort: 'high' } });
    expect(frozen('some-unknown-model', 'quick')).toEqual({ kind: 'frozen', controls: { omitReasoning: true } });
  });
});

describe('lane -> tier', () => {
  it('chat takes the configured tier, everything else is fixed', () => {
    const table = (chat: EffortTier) => (['chat', 'child', 'deep-child', 'routine', 'job'] as const).map((lane) => tierForLane(lane, chat));
    expect(table('quick')).toEqual(['quick', 'standard', 'deep', 'standard', 'standard']);
    expect(table('deep')).toEqual(['deep', 'standard', 'deep', 'standard', 'standard']);
  });
});

const OWNER = 'owner-a';
const AGENT = 'agent-a';
const CONV = 'conv-a';
const NOW = '2026-10-22T00:00:00.000Z';
const MUSE = 'muse-spark-1.3-contributor';
const LUNA = 'gpt-5.6-luna';

const settings = appSettingsSchema.parse({
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: '', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
});

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

async function setModels(store: Store, models: { defaultModel: string; providerId: string; tiers?: Tiers }): Promise<void> {
  await runWithOwner(OWNER, async () => {
    await store.put('modelProviders', { id: 'mprov-1', ownerId: OWNER, apiKey: sealProviderKey('sk-test'), createdAt: NOW, updatedAt: NOW, kind: 'builtin', name: 'OpenCode Go', providerId: 'opencode-go' });
    await store.put('settings', { ...settings, models, id: settingsIdFor(OWNER) });
  });
}

async function setup(opts: { chatTier?: EffortTier; tiers?: Tiers } = {}) {
  const store = createMemoryStore();
  await setModels(store, { defaultModel: MUSE, providerId: 'mprov-1', ...(opts.tiers === undefined ? {} : { tiers: opts.tiers }) });
  const selection = createAccountModelSelection({
    store,
    config: backendConfigSchema.parse(opts.chatTier === undefined ? {} : { CHAT_EFFORT_TIER: opts.chatTier }),
    createProvider: () => ({ async call() { throw new Error('not called'); } }),
  });
  const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: undefined, modelSelection: selection });
  const child = async (runId: string, flags: { deep?: true; fast?: true } = {}) => {
    const row: Run & { deepEffort?: true; fastModel?: true } = { id: runId, agentId: AGENT, conversationId: CONV, title: 't', status: 'running', kind: 'background', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: NOW, lastActivityAt: NOW, ...(flags.deep === true ? { deepEffort: true as const } : {}), ...(flags.fast === true ? { fastModel: true as const } : {}) };
    await store.put('runs', row, { agentId: AGENT, conversationId: CONV, runId });
    return childSessionKey(AGENT, CONV, runId);
  };
  const wake = (kind: WakeEvent['kind']): WakeEvent => ({ id: 'w1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind, origin: { type: 'automation' }, trusted: true, priority: 'background', payload: {}, at: NOW, status: 'accepted' });
  const build = (sessionKey: string, extra: { wake?: WakeEvent[]; previousContext?: Awaited<ReturnType<typeof brain.buildContext>> } = {}) =>
    runWithOwner(OWNER, () => brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey, wake: extra.wake ?? [], ...(extra.previousContext === undefined ? {} : { previousContext: extra.previousContext }) }));
  const effort = async (context: ReturnType<typeof build>) => parseModelSnapshot(await context)?.controls?.reasoningEffort;
  const model = async (context: ReturnType<typeof build>) => parseModelSnapshot(await context)?.modelId;
  return { store, child, wake, build, effort, model, selection };
}

const CHAT = AGENT + ':' + CONV;

describe('the effort frozen on a run', () => {
  it('chat is quick, a child and a routine are standard, a deep child is deep', async () => {
    const { child, wake, build, effort } = await setup();
    expect(await effort(build(CHAT))).toBe('minimal');
    expect(await effort(build(CHAT, { wake: [wake('user_message')] }))).toBe('minimal');
    expect(await effort(build(await child('c1')))).toBe('low');
    expect(await effort(build(await child('c2', { deep: true })))).toBe('high');
    expect(await effort(build(CHAT, { wake: [wake('routine')] }))).toBe('low');
    expect(await effort(build(CHAT, { wake: [wake('monitor')] }))).toBe('low');
  });

  it('CHAT_EFFORT_TIER moves only the chat lane', async () => {
    const { child, build, effort } = await setup({ chatTier: 'deep' });
    expect(await effort(build(CHAT))).toBe('high');
    expect(await effort(build(await child('c1')))).toBe('low');
  });

  it('a row\'s effort moves only its own lane: chat, task (child, routine, job) and deep', async () => {
    const { child, wake, build, effort } = await setup({ tiers: { chat: { effort: 'max' }, task: { effort: 'medium' }, deep: { effort: 'xhigh' } } });
    expect(await effort(build(CHAT))).toBe('max');
    expect(await effort(build(await child('c1')))).toBe('medium');
    expect(await effort(build(CHAT, { wake: [wake('routine')] }))).toBe('medium');
    expect(await effort(build(await child('c2', { deep: true })))).toBe('xhigh');
  });

  it('a row that names only a model takes the tier\'s effort on that model, and a row that names nothing is the default', async () => {
    const { child, build, effort, model } = await setup({ tiers: { task: { providerId: 'mprov-1', modelId: LUNA }, deep: {} } });
    expect(await model(build(await child('c1')))).toBe(LUNA);
    expect(await effort(build(await child('c1')))).toBe('low');
    expect(await model(build(CHAT))).toBe(MUSE);
    expect(await model(build(await child('c2', { deep: true })))).toBe(MUSE);
    expect(await effort(build(await child('c3', { deep: true })))).toBe('high');
  });

  it('a row with a model and an effort uses both; the fast row never moves the deep or task rows', async () => {
    const { child, build, effort, model } = await setup({ tiers: { deep: { providerId: 'mprov-1', modelId: LUNA, effort: 'max' }, fast: { providerId: 'mprov-1', modelId: LUNA, effort: 'medium' } } });
    expect(await model(build(await child('c1', { deep: true })))).toBe(LUNA);
    expect(await effort(build(await child('c2', { deep: true })))).toBe('max');
    expect(await model(build(await child('c3', { fast: true })))).toBe(LUNA);
    expect(await effort(build(await child('c4', { fast: true })))).toBe('medium');
    expect(await model(build(await child('c5')))).toBe(MUSE);
  });

  it('an effort the chosen model does not offer fails the run loudly', async () => {
    const { build } = await setup({ tiers: { chat: { effort: 'minimal', providerId: 'mprov-1', modelId: LUNA } } });
    await expect(build(CHAT)).rejects.toMatchObject({ code: 'unsupported-reasoning' });
  });

  it('a row naming a provider the owner no longer has is ignored', async () => {
    const { build, effort, model } = await setup({ tiers: { chat: { providerId: 'mprov-gone', modelId: LUNA, effort: 'max' } } });
    expect(await model(build(CHAT))).toBe(MUSE);
    expect(await effort(build(CHAT))).toBe('minimal');
  });

  it('describeTiers answers what each tier runs on and whether the owner chose it', async () => {
    const { selection } = await setup({ tiers: { task: { providerId: 'mprov-1', modelId: LUNA }, chat: { effort: 'high' } } });
    const tiers = await selection.describeTiers?.(OWNER);
    expect(tiers).toEqual({
      chat: { providerId: 'mprov-1', modelId: MUSE, effort: 'high', source: 'chosen' },
      task: { providerId: 'mprov-1', modelId: LUNA, effort: 'low', source: 'chosen' },
      deep: { providerId: 'mprov-1', modelId: MUSE, effort: 'high', source: 'default' },
      // Auto: the provider's cheap-marked model.
      fast: { providerId: 'mprov-1', modelId: 'qwen3.8-flash', effort: 'low', source: 'default' },
    });
  });

  it('stays frozen across steps: a rebuild keeps the snapshot even when the setting or the tier source changes', async () => {
    const { store, child, build, effort } = await setup();
    const chat = await build(CHAT);
    const sub = await build(await child('c1'));
    await setModels(store, { defaultModel: MUSE, providerId: 'mprov-1', tiers: { chat: { effort: 'max' }, task: { effort: 'max' } } });
    expect(await effort(build(CHAT, { previousContext: chat }))).toBe('minimal');
    expect(await effort(build(await child('c1'), { previousContext: sub }))).toBe('low');
    // A new run of the same conversation picks the owner's new setting up: the one accepted cache miss.
    expect(await effort(build(CHAT))).toBe('max');
  });
});
