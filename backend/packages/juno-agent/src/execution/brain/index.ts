import type { PlatformSkillsService } from '@agent-desktop/memory-graph/skills';
import { requestCacheShape } from './request-cache.js';
import type { HarnessPins } from '../../modules/harness/store.js';
import { withSessionHarness } from '../../modules/harness/pin.js';
import type { AssistantTurn, BlobStore, Brain, BrainContext, Compaction, Store, TranscriptEntry } from '../../contracts/index.js';
import { LIMITS } from '../../contracts/index.js';
import { buildContext, hydrateContext, projectMessages, readProviderLimits, resolveFrozenModel, slimContext, type BrainContextData, type ComputerEnvironmentSource } from './context.js';
import { isSystemEntry } from './context-notes.js';
import type { HomeDeps } from '../../modules/home/service.js';
import type { MemoryPort } from '../../modules/memory/port.js';
import type { ConnectorCatalog } from '../../modules/mcp/catalog.js';
import type { Message } from '@earendil-works/pi-ai';
import type { Tool } from '../../contracts/index.js';
import {
  compactionTailBudgetTokens,
  estimateMessagesTokens,
  createCompaction,
  planCompaction,
  readLatestCompaction,
  summaryRequestMessage,
} from './compaction.js';
import type { LimitsAwareProvider } from './model-limits.js';
import { readTranscript } from './transcript.js';
import { withImages } from './transcript-images.js';
import { currentHarnessVersion, harnessText } from '../../modules/harness/loader.js';
import { modelProviderRequired, parseModelSnapshot, type ModelSelection } from './model-selection.js';
import { currentOwnerId } from '../../owner-context.js';
import type { SystemOne } from '../../ports/system-one/index.js';
import { createModelFetch } from '../../modules/tools/net/guardedFetch.js';
import { resolveSystemOne } from './system-one.js';
import { createJevSystemOne, type JevEndpoint } from './system-one-jev.js';
import { createEmulatedSystemOne } from './system-one-emulation.js';
import { contextPressure, withMetrics, withoutMetrics, type CompactionMetrics } from './compaction-metrics.js';

/** Deadline for one auxiliary call (run title / role suggestion); the run never waits on it. */
const QUICK_TEXT_TIMEOUT_MS = 20_000;
/** Deadline for one background call of the memory jobs. */
const BACKGROUND_TEXT_TIMEOUT_MS = 5 * 60_000;
/** Session key prefix the scripted test model reads as "no auxiliary answer". */
export const QUICK_TEXT_SESSION_KEY = 'aux:quick-text';
/** A chat idle for an hour is compacted in the background only when it holds more than this many tokens; inside a run only the window rule compacts. */
const IDLE_COMPACT_MIN_TOKENS = 128_000;
/** Deadline for one System One call; the reviewers sit in a tool step and fail closed when it passes. */
const SYSTEM_ONE_TIMEOUT_MS = 20_000;

export interface BrainInput {
  platformSkills?: Pick<PlatformSkillsService, 'catalog'>;
  store: Store;
  /** Transcript images are stored there; they are read back into each model request (BACKEND §5.2a). */
  blobs: BlobStore;
  /** The platform default provider (MODEL_*). Absent when unconfigured: owners then need a provider of their own. */
  provider?: LimitsAwareProvider;
  /** Account-wide model choice. Absent keeps the legacy bootstrap provider everywhere. */
  modelSelection?: ModelSelection;
  /** Optional bound-computer lookup, rendered once per run into the system prompt. */
  environment?: ComputerEnvironmentSource;
  /** The user's computer home and a warning log for the context sync (BACKEND §5.3); absent leaves those sections to the mirror. */
  home?: Pick<HomeDeps, 'home' | 'log' | 'skills'> & { memory?: MemoryPort };
  /** The platform's own System One endpoint (SYSTEM_ONE_*); absent when not configured. */
  systemOne?: JevEndpoint;
  /** Static system-prompt sections from the host's plugins (text only, in order); part of every session's frozen system message. */
  promptSections?: readonly string[];
  /** The connector catalog: what each app the agent can use does, in the "Where you are" section. */
  connectorCatalog?: ConnectorCatalog;
  /** Resolves the harness version a session is pinned to (BACKEND §11.2); absent reads the active version. */
  harness?: HarnessPins;
}

export async function createBrain({ store, blobs, provider, modelSelection, environment, home, systemOne: platformSystemOne, promptSections, connectorCatalog, harness, platformSkills }: BrainInput): Promise<Brain> {
  return {
    buildContext: (opts) => buildContext(store, {
      ...opts,
      ...(platformSkills === undefined ? {} : { platformSkills }),
      ...(harness ? { harness } : {}),
      ...(promptSections ? { promptSections } : {}),
      ...(connectorCatalog ? { connectorCatalog } : {}),
      ...(environment ? { environment } : {}),
      ...(home ? { home } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      provider,
    }),
    slim: slimContext,
    withSessionHarness: (entries, fn) => withSessionHarness(harness, entries, fn),
    async step(ctx, tools, opts) {
      const started = Date.now();
      const context = await hydrateContext(store, ctx);
      const messages = await withImages(blobs, context.messages);
      const hydrateMs = Date.now() - started;
      const cacheShape = requestCacheShape(messages, tools);
      const onStats = opts.onStats;
      return activeProvider(context).call({
        messages,
        tools,
        signal: opts.signal,
        onDelta: opts.onDelta,
        sessionKey: context.sessionKey,
        ...(onStats === undefined ? {} : { onStats: (stats) => onStats({ ...stats, hydrateMs, ...cacheShape }) }),
      });
    },
    async toolSearchMode(agentId) {
      try {
        return (await modelSelection?.resolve(agentId))?.toolSearch ?? 'proxy';
      } catch {
        // No usable model yet: the run fails with the real reason when its context is built.
        return 'proxy';
      }
    },
    shouldCompact(ctx) {
      return (contextPressure(ctx) ?? 0) > 1;
    },
    // Background one-shots (titles, role suggestions, purchase and dialog review) run on the fast model
    // (BACKEND §10.14), never a run's frozen model: no tools and a short deadline. With no fast model
    // the platform's main model answers; with neither, null (the same answer a failed call gives).
    async quickText(prompt, agentId) {
      try {
        const used = (await auxModel(agentId)).provider;
        if (used === undefined) return null;
        const turn = await used.call({
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          tools: [],
          signal: AbortSignal.timeout(QUICK_TEXT_TIMEOUT_MS),
          sessionKey: QUICK_TEXT_SESSION_KEY,
        });
        const text = turn.text.trim();
        return turn.stopReason === 'stop' && turn.toolCalls.length === 0 && text !== '' ? text : null;
      } catch {
        return null;
      }
    },
    // Typed decisions for the current owner: their System One endpoint, else the platform's, else the fast model answering
    // the same questions as strict JSON, else null. Every failure is null too.
    systemOne: {
      async ask(state, questions, signal, options) {
        try {
          const ownerId = currentOwnerId();
          const selection = ownerId === undefined
            ? undefined
            : await resolveSystemOne(store, ownerId, platformSystemOne);
          const guarded = AbortSignal.any([signal, AbortSignal.timeout(SYSTEM_ONE_TIMEOUT_MS)]);
          // An owner's own endpoint goes through the SSRF-guarded client; the platform's is trusted configuration.
          if (selection !== undefined) {
            const native = createJevSystemOne(selection.endpoint, selection.source === 'chosen' ? createModelFetch() : fetch);
            return await native.ask(state, questions, guarded, options);
          }
          if (ownerId === undefined && platformSystemOne !== undefined) {
            return await createJevSystemOne(platformSystemOne).ask(state, questions, guarded, options);
          }
          // Native-only discovery (allowEmulation false) never spends a hidden fast-model
          // call: no chosen or platform endpoint means null, with no emulation fallback.
          if (options?.allowEmulation === false) return null;
          const emulated = await emulation();
          return emulated === undefined ? null : await emulated.ask(state, questions, guarded, options);
        } catch {
          return null;
        }
      },
    },
    // The memory jobs: the fast model, else the model this agent would run on. Usage and model come back so the caller records the spend.
    async completeText(input) {
      try {
        const { provider: used, modelId } = await auxModel(input.agentId);
        if (used === undefined) return null;
        const turn = await used.call({
          messages: [
            { role: 'system', content: input.system, timestamp: Date.now() },
            { role: 'user', content: input.prompt, timestamp: Date.now() },
          ],
          tools: [],
          signal: AbortSignal.timeout(BACKGROUND_TEXT_TIMEOUT_MS),
          sessionKey: input.sessionKey,
        });
        const text = turn.text.trim();
        return turn.stopReason === 'stop' && turn.toolCalls.length === 0 && text !== ''
          ? { text, usage: turn.usage, ...(modelId === undefined ? {} : { model: modelId }) }
          : null;
      } catch {
        return null;
      }
    },
    async compact(ctx, tools) {
      const started = Date.now();
      return compactContext(await hydrateContext(store, ctx), tools, started);
    },
    // Background compaction of a quiet chat: the model a new run would get, a standalone summary request
    // (no run prefix to reuse), and no context note (the next build re-sends sections the summary folded away).
    async compactIdle({ agentId, sessionKey }) {
      const started = Date.now();
      const harnessVersion = currentHarnessVersion().id;
      const frozen = await resolveFrozenModel(modelSelection, agentId, undefined);
      const limits = await readProviderLimits(frozen ? frozen.provider : provider);
      const supportsImages = frozen === undefined || frozen.snapshot.supportsImages;
      const previous = await readLatestCompaction(store, sessionKey);
      const messages = projectMessages(await readTranscript(store, sessionKey), previous, supportsImages);
      if (estimateMessagesTokens(messages) <= IDLE_COMPACT_MIN_TOKENS) return;
      const compacted = await compactContext({
        sessionKey, agentId, messages, systemPrompt: '', compactionEpoch: previous?.epoch ?? 0,
        ...(frozen ? { modelSelection: frozen.snapshot } : {}), ...limits,
      }, undefined, started);
      home?.log?.({ agentId, sessionKey, metrics: compacted['compactionMetrics'], harnessVersion }, 'idle compaction');
    },
  };

  /** Everything after hydration: plan, summarize, guard against a concurrent writer, commit the checkpoint. */
  async function compactContext(context: BrainContextData, tools: Tool[] | undefined, started: number): Promise<BrainContext> {
      const entries = await readTranscript(store, context.sessionKey);
      const previous = await readLatestCompaction(store, context.sessionKey);
      // Only entries past the last checkpoint are eligible: re-compacting folds the prior summary
      // in once and never re-summarizes raw history already covered. The frozen system row is
      // never summarized or dropped.
      const pending = entries.filter(entry => !isSystemEntry(entry) && entry.seq > (previous?.uptoSeq ?? -1));
      const plan = planCompaction(pending, compactionTailBudgetTokens(context.contextWindow));
      // A real no-op never called the provider, so a previous measurement must not be carried on.
      if (plan === null) return withoutMetrics(context);
      const selectedPrefix = transcriptPrefixSnapshot(plan.older);
      const frozenProvider = activeProvider(context);
      // Compaction summarizes with the run's frozen model, never the current account default. When
      // the run's tools are known the request reuses the run's own prefix (same system message, same
      // tools, the history up to the cut) plus one trailing instruction, so the provider serves the
      // whole prefix from its cache; anything unusable falls back to the standalone summary request.
      let attempt = tools === undefined
        ? undefined
        : await summarizeWithPrefix(frozenProvider, tools, await withImages(blobs, projectUpTo(entries, previous, plan.uptoSeq, context.modelSelection?.supportsImages !== false)), context.sessionKey);
      if (attempt === undefined || attempt.text === null) {
        const fallback = await summarizeOlderHistory(frozenProvider, plan.older, previous?.summary);
        attempt = { text: fallback.text, usage: sumUsage(attempt?.usage, fallback.usage) };
      }
      // The request was really spent, so its measurement is attached on EVERY attempted path.
      const spent: CompactionMetrics = {
        durationMs: Math.max(0, Date.now() - started),
        ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
      };
      if (attempt.text === null) return withMetrics(context, spent);
      // Re-read the authoritative checkpoint and transcript after the summary await: a concurrent
      // compaction may have committed a newer checkpoint while this summary was in flight, and new
      // transcript rows (tool results, steered user messages) may have landed after the plan was cut.
      // This is a best-effort in-process guard, not a distributed compare-and-swap: the loser simply
      // skips its write and the winner's checkpoint stands.
      const freshCheckpoint = await readLatestCompaction(store, context.sessionKey);
      const freshEntries = await readTranscript(store, context.sessionKey);
      const checkpointMoved =
        (freshCheckpoint?.epoch ?? null) !== (previous?.epoch ?? null) ||
        (freshCheckpoint?.uptoSeq ?? -1) !== (previous?.uptoSeq ?? -1);
      if (checkpointMoved) return withMetrics(context, spent);
      const freshPrefix = freshEntries.filter(entry =>
        !isSystemEntry(entry) && entry.seq > (previous?.uptoSeq ?? -1) && entry.seq <= plan.uptoSeq);
      const prefixIntact = transcriptPrefixSnapshot(freshPrefix) === selectedPrefix;
      if (!prefixIntact) return withMetrics(context, spent);
      // The durable checkpoint is the epoch authority: a stale context epoch must never rewind it.
      const epoch = Math.max(context.compactionEpoch, freshCheckpoint?.epoch ?? 0) + 1;
      const recentUsers = recentUserTexts(previous?.recentUsers, plan.older, recentUserTokens(context.contextWindow));
      const created = createCompaction(context.sessionKey, epoch, attempt.text, plan.uptoSeq, recentUsers);
      await store.put('compactions', created);
      // Project from the post-commit transcript, not the pre-summary plan, so rows appended during
      // the summary call (tool results, new user messages) stay in the returned context.
      const after = await readTranscript(store, context.sessionKey);
      const messages = projectMessages(after, created, context.modelSelection?.supportsImages !== false);
      return {
        ...withMetrics(context, spent),
        messages,
        compactionEpoch: epoch,
        checkpointEpoch: epoch,
        uptoSeq: after.reduce((top, entry) => (isSystemEntry(entry) ? top : Math.max(top, entry.seq)), -1),
        contextTokens: estimateMessagesTokens(messages),
      };
  }

  /**
   * The model for background one-shots: the owner's fast model, else the model `agentId` runs on. Always a resolved snapshot when one
   * exists, never the bare platform provider: only a snapshot carries the frozen reasoning default the model accepts (the bare Responses
   * provider sends effort `none`, which Muse Spark rejects with a 400). The bare provider is the last resort when nothing resolves.
   */
  async function auxModel(agentId: string | undefined): Promise<{ provider: LimitsAwareProvider | undefined; modelId?: string }> {
    const fast = await modelSelection?.resolveFast?.(currentOwnerId(), 'job');
    const snapshot = fast?.snapshot ?? (modelSelection === undefined || agentId === undefined ? undefined : await modelSelection.resolve(agentId, 'job'));
    if (snapshot === undefined || modelSelection === undefined) return { provider };
    return { provider: modelSelection.providerFor(snapshot), modelId: snapshot.modelId };
  }

  /** The provider of the current owner's fast model; else the platform's main provider; else undefined. */
  async function fastModelProvider(): Promise<{ provider: LimitsAwareProvider; modelId?: string } | undefined> {
    const chosen = await modelSelection?.resolveFast?.(currentOwnerId());
    if (chosen !== undefined && modelSelection !== undefined) return { provider: modelSelection.providerFor(chosen.snapshot), modelId: chosen.snapshot.modelId };
    return provider === undefined ? undefined : { provider };
  }

  /** System One emulated by the fast model; undefined when there is no fast model. */
  async function emulation(): Promise<SystemOne | undefined> {
    const fast = await fastModelProvider();
    if (fast === undefined) return undefined;
    return createEmulatedSystemOne(async (system, user, signal) => {
      const turn = await fast.provider.call({
        messages: [{ role: 'system', content: system, timestamp: Date.now() }, { role: 'user', content: user, timestamp: Date.now() }],
        tools: [],
        signal,
        sessionKey: QUICK_TEXT_SESSION_KEY,
      });
      return turn.stopReason === 'stop' && turn.toolCalls.length === 0 ? turn.text : null;
    });
  }

  /** The run's frozen provider when the context journals a snapshot, else the bootstrap provider. */
  function activeProvider(context: BrainContextData): LimitsAwareProvider {
    const frozen = parseModelSnapshot(context);
    if (frozen === undefined || modelSelection === undefined) {
      if (provider === undefined) throw modelProviderRequired();
      return provider;
    }
    return modelSelection.providerFor(frozen);
  }
}

/** Freeze the selected messages before awaiting the provider, including row identity and order. */
function transcriptPrefixSnapshot(entries: TranscriptEntry[]): string {
  return JSON.stringify(entries.map(entry => ({ id: entry.id, seq: entry.seq, message: entry.message })));
}

/**
 * Summarize older history with the provider itself: no tools. A truncated (length), error, or aborted
 * turn, a turn carrying tool calls instead of a final answer, a blank/whitespace summary, or a
 * provider failure all reject the summary and leave the durable transcript and any existing
 * checkpoint untouched. The summary prompt asks for a short handoff, so the provider's output
 * maximum never becomes a forced long summary. The abort follows the run's active cap rather than a
 * fixed guess, leaving first-response and idle deadlines to the provider watchdog so a slow but
 * progressing model is not cut short.
 */
async function summarizeOlderHistory(
  provider: LimitsAwareProvider,
  older: TranscriptEntry[],
  previousSummary: string | undefined,
): Promise<SummaryAttempt> {
  try {
    const turn = await provider.call({
      messages: [summaryRequestMessage(older, previousSummary)],
      tools: [],
      signal: AbortSignal.timeout(LIMITS.run.maxActiveSeconds * 1000),
    });
    const summary = turn.text.trim();
    // Measured usage is carried even when the text is unusable (truncated, tool call, empty).
    const usable = turn.stopReason === 'stop' && turn.toolCalls.length === 0 && summary.length > 0;
    return { text: usable ? summary : null, usage: turn.usage };
  } catch {
    // A rejected request reported no usage, so only the measured time is charged.
    return { text: null };
  }
}

/** The instruction that closes a prefix-reusing summary request (the conversation above is the run's own prefix). */
const prefixSummaryInstruction = (): string => harnessText('compaction.prefix_summary') + ' ' + harnessText('compaction.topics_by_date');
/** Newest user messages kept verbatim across a compaction: at most 8k tokens, and never more than an eighth of the window. */
function recentUserTokens(contextWindow: number | undefined): number {
  return Math.max(256, Math.min(8_000, Math.floor((contextWindow ?? 64_000) / 8)));
}

/** The projected history up to the cut: exactly the front part of the run's own request, so it is cache-shared. */
function projectUpTo(entries: TranscriptEntry[], checkpoint: Compaction | null, uptoSeq: number, supportsImages: boolean): Message[] {
  return projectMessages(entries.filter(entry => isSystemEntry(entry) || entry.seq <= uptoSeq), checkpoint, supportsImages);
}

/** Summary from the run's own prefix. Undefined when the request itself failed; text null when the reply was unusable (e.g. a tool call). */
async function summarizeWithPrefix(
  provider: LimitsAwareProvider,
  tools: Tool[],
  prefix: Message[],
  sessionKey: string,
): Promise<SummaryAttempt | undefined> {
  try {
    const turn = await provider.call({
      messages: [...prefix, { role: 'user', content: prefixSummaryInstruction(), timestamp: Date.now() }],
      tools,
      signal: AbortSignal.timeout(LIMITS.run.maxActiveSeconds * 1000),
      sessionKey,
    });
    const summary = turn.text.trim();
    const usable = turn.stopReason === 'stop' && turn.toolCalls.length === 0 && summary.length > 0;
    return { text: usable ? summary : null, usage: turn.usage };
  } catch {
    return undefined;
  }
}

/** Both attempts were really spent; their usage adds up. */
function sumUsage(first: AssistantTurn['usage'] | undefined, second: AssistantTurn['usage'] | undefined): AssistantTurn['usage'] | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    ...second,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    costUsd: first.costUsd + second.costUsd,
  };
}

/** The user texts of a transcript slice (a note or an earlier compaction block is not the user's own words). */
function userTexts(entries: TranscriptEntry[]): string[] {
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.message['role'] !== 'user') continue;
    const content = entry.message['content'];
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block: unknown) => (typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text' ? String(Reflect.get(block, 'text') ?? '') : '')).join('\n')
        : '';
    if (text.trim().length > 0 && !text.startsWith('<context_update>')) texts.push(text);
  }
  return texts;
}

/** Previously kept messages plus the newly summarized ones, newest first up to the token budget, oldest to newest. */
function recentUserTexts(previous: string[] | undefined, older: TranscriptEntry[], tokens: number): string[] {
  const candidates = [...(previous ?? []), ...userTexts(older)];
  const kept: string[] = [];
  let chars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const text = candidates[index] ?? '';
    if (kept.length > 0 && chars + text.length > tokens * 4) break;
    kept.unshift(text.length > tokens * 4 ? text.slice(0, tokens * 4) : text);
    chars += text.length;
  }
  return kept;
}

/** One summarization attempt: the usable text (null when unusable) and what the request cost. */
interface SummaryAttempt {
  text: string | null;
  usage?: AssistantTurn['usage'];
}

export { createOpenAIProvider } from './provider.js';
export type { ModelProvider } from './provider.js';
export { createModelLimitsSource, knownLimits } from './model-limits.js';
export type { ModelLimits, ModelLimitsSource, LimitsAwareProvider } from './model-limits.js';
export { createModelCatalogLoader, getModelCatalogLoader, readModelEnv } from './model-catalog.js';
export type { LoadedCatalog, ModelCatalogLoader, ModelEnv } from './model-catalog.js';
export { createAccountModelSelection, parseModelSnapshot, toTerminalModelError, ModelSelectionError } from './model-selection.js';
export type { ModelSelection, ModelSelectionErrorCode, ModelSnapshot } from './model-selection.js';
export { appendToTranscript, appendWakeEvents, readTranscript } from './transcript.js';
export { offloadImages } from './transcript-images.js';
export { assistantMessage, toolMessage, wakeMessage, parseMessage } from './messages.js';
export { chatTakesReactions } from './where-you-are.js';export type { Brain, BrainContext, AssistantTurn } from '../../contracts/index.js';
export type { ComputerEnvironmentSource, RunComputerEnvironment } from './context.js';
