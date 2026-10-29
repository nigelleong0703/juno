import { createHash } from 'node:crypto';
import type { AssistantTurn, ModelCallStats, Tool, ToolSearchMode } from '../../contracts/index.js';
import type { ReasoningEffort } from '@agent-desktop/public-contracts';
import type { BackendConfig } from '../config.js';
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ModelCost,
  Provider,
  ProviderResponse,
  StreamOptions,
} from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai';
import { stream as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { aliasToolNamesInMessages, aliasToolNamesInResult, createToolNameAliases } from './toolNames.js';
import { createModelLimitsSource, type ModelLimits, type ModelLimitsSource } from './model-limits.js';
import { createStreamWatchdog } from './stream-watchdog.js';
import { ModelTurnError } from './model-turn-error.js';
import { classifyProviderFailure, ProviderFailureError } from './model-failure.js';
import { assistantWireCompatFor, responsesModelFor, wireModelFor, type WireModelRequest } from './provider-wire-compat.js';
import { stripReplayedThinking } from './replay-sanitize.js';
import { createNativeSearchTap, nativeWireOf, type NativeSearchTap } from './native-web-search.js';
import { createToolSearchTap, type DeferredTool, type ToolSearchTap } from './native-tool-search.js';
import { unwrapProxyCalls } from './tool-proxy.js';
import { isDiscoveryTool } from '../../modules/tools/tools/toolSearch.js';
import { createResponsesWsTransport, defaultEndpoint, type WsCall } from './ws-responses.js';
export { toAssistantUsage } from './provider-usage.js';
import { toAssistantUsage } from './provider-usage.js';

export interface ModelProvider {
  getLimits?(): Promise<ModelLimits>;
  call(options: { messages: Message[]; tools: Tool[]; signal: AbortSignal; onDelta?: (text: string) => void; sessionKey?: string; onStats?: (stats: ModelCallStats) => void }): Promise<AssistantTurn & { message?: AssistantMessage }>;
}


/** Stable per-session headers for prompt-cache affinity (platform default and owner providers alike); the raw session key (agent and conversation ids) is hashed. */
export function cacheAffinityHeaders(sessionKey: string): Record<string, string> {
  const id = hashedSessionId(sessionKey);
  return { 'session-id': id, 'thread-id': id, 'x-client-request-id': id };
}

/** The session id sent upstream: a hash, never the raw agent and conversation ids. */
function hashedSessionId(sessionKey: string): string {
  return 'juno-' + createHash('sha256').update(sessionKey).digest('hex').slice(0, 32);
}

export interface OpenAIProviderOptions {
  /** Whether MODEL_ID accepts image input. Default false: a text-only model must not receive images. */
  supportsImages?: boolean;
  firstResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  /** Account runtime controls, frozen per run and already capability-checked. Absent keeps defaults. */
  reasoningEffort?: ReasoningEffort;
  /** Responses wire: send no reasoning at all. */
  omitReasoning?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /** Explicit USD-per-million-token rates for this exact endpoint/model; absent stays unknown. */
  pricing?: ModelCost;
  /** Frozen per run: the provider's own web search tool is added to every request (Juno's web_search is then not offered). */
  nativeWebSearch?: boolean;
  /** Frozen per run: hidden tools (`deferLoading` in the call's tools) are declared as deferred functions behind the provider's tool search; otherwise they are left out and reached through tool_call. */
  toolSearch?: ToolSearchMode;
}

/**
 * Where one model call goes: the pi-ai model (wire api, endpoint, compat), the credential resolved
 * for that call, the limits source and the transport. The platform default and an owner's own
 * provider differ only in this source; the call path is shared.
 */
export interface ModelSource {
  /**
   * The credential and the pi-ai model for one call, read now. A user provider re-reads its owner's
   * stored key and endpoint here, so a changed or revoked provider is seen by the very next call.
   */
  resolve(): Promise<ResolvedCall>;
  limits: ModelLimitsSource;
  /** Transport override (SSRF-guarded fetch for user endpoints). Absent uses the global fetch. */
  fetch?: typeof fetch;
  /**
   * Whether the hashed session id is also passed to pi-ai as `sessionId`: `prompt_cache_key` on the Responses
   * wire and the session_id header. Owner providers send it; the platform default keeps the affinity headers
   * alone (its measured routing). Built-in catalog models are owner providers, so they send it too.
   */
  sessionIdBody: boolean;
  /** Hint appended to the text-only refusal; names the setting the owner can change. */
  textOnlyHint: string;
}

export interface ResolvedCall {
  apiKey: string;
  /** The pi-ai model for this call, built once the limits known for it are in hand. */
  buildModel(limits: ModelLimits): Model<Api>;
  /**
   * A built-in model's own pi-ai provider. Its stream adds what that vendor requires on each request
   * (OpenCode's `x-opencode-session` routing header, for example), which the bare wire adapters do
   * not; such a call also carries a hashed per-session `sessionId`.
   */
  provider?: Provider;
}

/**
 * The smallest defined limit. A known model maximum caps an account output request; an unknown
 * maximum is never guessed, so nothing is sent and the provider keeps its own default.
 */
function smallestKnown(...values: Array<number | undefined>): number | undefined {
  let smallest: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (smallest === undefined || value < smallest) smallest = value;
  }
  return smallest;
}

/** How many images a request carries and their base64 size in KB (for the call log; no content). */
function imageLoad(messages: readonly Message[]): { images: number; imageKB: number } {
  let images = 0;
  let chars = 0;
  for (const message of messages) {
    if (message.role === 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      images += 1;
      chars += block.data.length;
    }
  }
  return { images, imageKB: Math.round(chars / 1024) };
}

/**
 * With `supportsImages:false` pi-ai replaces every image block with a placeholder text instead of
 * sending it (api/transform-messages.js downgradeUnsupportedImages), so a screenshot silently becomes
 * "(image omitted)". Return which message carries the image so the provider can refuse loudly.
 */
function imageInputSource(messages: readonly Message[]): string | undefined {
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image')) {
      return 'a user message';
    }
    if (message.role === 'toolResult' && message.content.some(block => block.type === 'image')) {
      return `the tool result for "${message.toolName}"`;
    }
  }
  return undefined;
}

/**
 * pi-ai streams the useful provider detail (for example the HTTP 400 body) on the error event, but a
 * bare "Model API error" hides it. Surface the detail when it exists, otherwise explain where to look,
 * and scrub any configured secret so an echoed credential never reaches the log.
 */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

/** Reasoning efforts Anthropic adaptive thinking accepts; `minimal` maps to its lowest level. */
function anthropicEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return effort === 'minimal' ? 'low' : effort;
}

/** A pi-ai model narrowed to one wire api. The guard reads the field; nothing is asserted. */
function isApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
  return model.api === api;
}

type NormalizedMessages = ReturnType<typeof normalizeContext>;
type StreamBase = StreamOptions;

/** Start the stream on the adapter the model's wire names; each API takes its own option shape. */
function streamFor(
  model: Model<Api>,
  messages: NormalizedMessages,
  input: { streamOptions: StreamBase; reasoningEffort: ReasoningEffort | undefined; temperature: number | undefined; provider: Provider | undefined },
) {
  const { reasoningEffort, temperature, provider } = input;
  const base = input.streamOptions;
  if (isApi(model, 'openai-responses')) {
    const options = {
      ...base,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(temperature === undefined ? {} : { temperature }),
    };
    return provider ? provider.stream(model, messages, options) : responsesStream(model, messages, options);
  }
  if (isApi(model, 'anthropic-messages')) {
    const options = {
      ...base,
      ...(reasoningEffort === undefined ? {} : { thinkingEnabled: true, effort: anthropicEffort(reasoningEffort) }),
      ...(temperature === undefined ? {} : { temperature }),
    };
    return provider ? provider.stream(model, messages, options) : anthropicStream(model, messages, options);
  }
  if (isApi(model, 'openai-completions')) {
    const options = {
      ...base,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      temperature: temperature ?? 0.7,
    };
    return provider ? provider.stream(model, messages, options) : completionsStream(model, messages, options);
  }
  throw new Error('Model wire "' + model.api + '" has no stream adapter in this backend');
}

/**
 * The model provider for one resolved source. Used by the platform default (OpenAI-compatible env
 * endpoint), a custom owner endpoint and a built-in catalog model. Callers validate their endpoint.
 */
export function createModelProvider(source: ModelSource, providerOptions: OpenAIProviderOptions = {}): ModelProvider {
  const supportsImages = providerOptions.supportsImages ?? false;
  const reasoningEffort = providerOptions.reasoningEffort;
  // Sockets live per session inside this provider; OpenAI's own endpoint only (MODEL_TRANSPORT=http turns it off).
  const wsTransport = process.env['MODEL_TRANSPORT'] === 'http' ? undefined : createResponsesWsTransport();

  return {
    getLimits: () => source.limits.getLimits(),
    async call(options) {
      const { messages: messagesInput, tools, signal, onDelta, sessionKey, onStats } = options;
      const started = Date.now();

      if (!supportsImages) {
        const image = imageInputSource(messagesInput);
        if (image !== undefined) {
          throw new Error(`Model capability error: ${image} contains an image but the model is configured text-only; refusing to send it without image input. ${source.textOnlyHint}`);
        }
      }

      // The OpenAI wire protocol only accepts [a-zA-Z0-9_-]{1,64}; registry names like shell.run are
      // mapped to valid protocol names here and mapped back out of the response below.
      // A hidden tool (deferLoading) is declared only behind the provider's tool search; in native mode the search tool is the
      // provider's own, so Juno's function of that name (and tool_load and the tool_call proxy) is not declared at all.
      const native = providerOptions.toolSearch === 'responses-tool-search';
      const hidden = native ? tools.filter((tool) => tool.deferLoading === true) : [];
      const declared = tools.filter((tool) => tool.deferLoading !== true && !(native && isDiscoveryTool(tool.name)));
      const aliases = createToolNameAliases([...declared, ...hidden].map((tool) => tool.name));
      const piDefinition = (tool: Tool) => ({ name: aliases.toProtocol(tool.name), description: tool.description, parameters: tool.parameters });
      const piTools = declared.map(piDefinition);
      const deferred: DeferredTool[] = hidden.map((tool) => ({ name: tool.name, tool: piDefinition(tool) }));

      signal.throwIfAborted();
      const resolved = await source.resolve();
      signal.throwIfAborted();
      const limits = await source.limits.getLimits();
      signal.throwIfAborted();
      const model = resolved.buildModel(limits);
      // No plain-text thinking is ever replayed (see replay-sanitize.ts). The one exception is the opaque
      // reasoning item (Responses) or signed thinking block (Anthropic) the same model produced.
      const identity = { api: model.api, provider: model.provider, model: model.id };
      const messages = normalizeContext({
        messages: stripReplayedThinking(aliasToolNamesInMessages(messagesInput, aliases), identity, {
          reasoningItems: model.api === 'openai-responses',
          wireReasoningField: model.api === 'openai-completions' && assistantWireCompatFor(model.id).requiresReasoningContentOnAssistantMessages,
          signedThinking: model.api === 'anthropic-messages' && reasoningEffort !== undefined,
        }),
        tools: piTools.length > 0 ? piTools : undefined,
      });

      const watchdog = createStreamWatchdog(signal, providerOptions.firstResponseTimeoutMs ?? 120_000, providerOptions.streamIdleTimeoutMs ?? 60_000);
      try {
        const apiKey = resolved.apiKey;
        const available = limits.contextWindow === undefined ? undefined : Math.max(1, limits.contextWindow - estimateContextTokens(messages).tokens);
        // Only a requested or published output maximum may cap the call; remaining context
        // clamps that cap but never invents one alone, so a context-only registry leaves
        // maxTokens absent and the gateway keeps its own default.
        const requestedMaximum = smallestKnown(limits.maxOutputTokens, providerOptions.maxOutputTokens);
        const outputMaximum = requestedMaximum === undefined ? undefined : available === undefined ? requestedMaximum : Math.min(requestedMaximum, available);
        // Direct stream leaves an unpublished output limit to the provider; streamSimple invents one.
        // The adapter surfaces each HTTP response, which is the only qualified status evidence.
        let observed: ProviderResponse | undefined;
        const wsCall: WsCall | undefined = wsTransport !== undefined && model.api === 'openai-responses' && defaultEndpoint(model.baseUrl.replace(/\/+$/, '') + '/responses') !== undefined
          ? wsTransport.forCall({ sessionKey, httpFetch: source.fetch })
          : undefined;
        const fetchOverride = wsCall?.fetch ?? source.fetch;
        const searchWire = providerOptions.nativeWebSearch === true ? nativeWireOf(model.api) : undefined;
        const searchTap: NativeSearchTap | undefined = searchWire === undefined ? undefined : createNativeSearchTap(searchWire);
        const toolSearchTap: ToolSearchTap | undefined = native && deferred.length > 0 && isApi(model, 'openai-responses')
          ? createToolSearchTap({ deferred, messages: messagesInput, supportsStrictMode: model.compat?.supportsStrictMode === true })
          : undefined;
        const taps = [toolSearchTap, searchTap].flatMap((tap) => (tap === undefined ? [] : [tap]));
        const streamOptions = {
          ...(taps.length === 0 ? {} : {
            onPayload: (payload: unknown) => taps.reduce((current, tap) => tap.payload(current) ?? current, payload),
            onProviderStreamEvent: (event: unknown) => { for (const tap of taps) tap.observe(event); },
          }),
          apiKey,
          signal: watchdog.signal,
          // Prompt-cache affinity: the gateway routes a session to the same cache by its session id
          // (Codex sends session-id/thread-id the same way). Without it almost nothing is cached.
          ...(sessionKey === undefined ? {} : { headers: cacheAffinityHeaders(sessionKey) }),
          // The same hashed id as pi-ai's sessionId (prompt_cache_key, session_id header); see ModelSource.sessionIdBody.
          ...(sessionKey === undefined || !source.sessionIdBody ? {} : { sessionId: hashedSessionId(sessionKey) }),
          ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
          onResponse: (response: ProviderResponse) => {
            observed = response;
          },
          ...(outputMaximum === undefined ? {} : { maxTokens: outputMaximum }),
        };
        const temperature = providerOptions.temperature;
        // Each wire takes its own option shape; the account effort maps to the one each API names.
        const prepMs = Date.now() - started;
        let firstEventMs: number | undefined;
        let firstTokenMs: number | undefined;
        const eventStream = streamFor(model, messages, { streamOptions, reasoningEffort, temperature, provider: resolved.provider });

        const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

        const iterator = eventStream[Symbol.asyncIterator]();
        while (true) {
          const next = await watchdog.wait(iterator.next());
          if (next.done) break;
          const event = next.value;
          firstEventMs ??= Date.now() - started;
          if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta' || event.type === 'toolcall_start') {
            firstTokenMs ??= Date.now() - started;
            watchdog.progress();
          }
          if (event.type === 'text_delta') {
            if (onDelta) onDelta(event.delta);
          } else if (event.type === 'toolcall_end') {
            toolCalls.push({
              id: event.toolCall.id,
              name: aliases.fromProtocol(event.toolCall.name),
              arguments: event.toolCall.arguments || {},
            });
          } else if (event.type === 'error') {
            const failure = classifyProviderFailure(event.error, observed, limits.contextWindow);
            throw new ProviderFailureError({ ...failure, message: redactSecrets(failure.message, [apiKey]) });
          }
        }

        const result = aliasToolNamesInResult(await watchdog.wait(eventStream.result()), aliases);
        const wire = wsCall?.info();
        onStats?.({
          ...imageLoad(messagesInput),
          ...(wire === undefined ? {} : { transport: wire.transport, delta: wire.delta, ...(wire.deltaItems === undefined ? {} : { deltaItems: wire.deltaItems }), ...(wire.fallback === undefined ? {} : { wsFallback: wire.fallback }) }),
          prepMs,
          ...(firstEventMs === undefined ? {} : { firstEventMs }),
          ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
          totalMs: Date.now() - started,
          ...(result.usage.reasoning === undefined ? {} : { reasoningTokens: result.usage.reasoning }),
        });
        const fullText = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (result.stopReason === 'length' && fullText.trim().length === 0 && toolCalls.length === 0) {
          throw new ModelTurnError('output_budget', 'Model exhausted its output budget without a reply or tool action. Please retry.');
        }

        const webSearches = searchTap?.searches() ?? [];
        // pi-ai dropped the tool_search_call items: they join the stored message and the calls as ordinary `tool_search` calls.
        const searches = toolSearchTap?.calls() ?? [];
        const message: AssistantMessage = searches.length === 0 ? result : { ...result, content: [...result.content, ...searches], stopReason: 'toolUse' };
        const calls = [...toolCalls, ...searches.map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))];
        return {
          message,
          text: fullText,
          ...(webSearches.length === 0 ? {} : { webSearches }),
          toolCalls: unwrapProxyCalls(calls),
          usage: toAssistantUsage(result.usage, providerOptions.pricing),
          stopReason: calls.length > 0 ? 'tool_calls' : result.stopReason === 'length' ? 'length' : 'stop',
        };
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(`Model API error: ${String(error)}`);
      } finally {
        watchdog.close();
      }
    },
  };
}

/**
 * The platform default: one OpenAI-compatible endpoint from MODEL_* env (the local OCX proxy in
 * development). Its wire identity, cache headers, limits probe and pricing are unchanged.
 */
export function createOpenAIProvider(config: BackendConfig, providerOptions: OpenAIProviderOptions = {}): ModelProvider {
  const { MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID } = config;
  const reasoningEffort = providerOptions.reasoningEffort;
  const pricing = providerOptions.pricing;
  // Responses is the default wire (encrypted reasoning items, same shape Codex sends); `chat` is the fallback.
  const useResponses = config.MODEL_WIRE_API === 'responses';
  const wireRequest = (limits: ModelLimits): WireModelRequest => ({
    modelId: MODEL_ID,
    baseUrl: MODEL_BASE_URL,
    supportsImages: providerOptions.supportsImages ?? false,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(providerOptions.omitReasoning === true ? { omitReasoning: true } : {}),
    ...(pricing === undefined ? {} : { pricing }),
    limits,
  });
  return createModelProvider({
    resolve: async () => ({
      apiKey: MODEL_API_KEY || '',
      buildModel: (limits) => (useResponses ? responsesModelFor(wireRequest(limits)) : wireModelFor(wireRequest(limits))),
    }),
    limits: createModelLimitsSource(config),
    sessionIdBody: false,
    textOnlyHint: 'Set MODEL_SUPPORTS_IMAGES=true when the model accepts images.',
  }, providerOptions);
}
