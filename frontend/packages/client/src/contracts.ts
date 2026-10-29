/**
 * The wire contracts (models, API surface, live events) come from the one shared definition the
 * backend validates against; this package only adds the HTTP transport on top.
 */
import type {
  ApiClient as PublicApiClient,
  ComputersApi as PublicComputersApi,
  ConversationsApi as PublicConversationsApi,
  ScreenResponse,
  FeedApi as PublicFeedApi,
  RoutinesApi as PublicRoutinesApi,
  ConfirmRelationResult,
  ListResult,
  MemoryItemStatus,
  MemoryItemTopic,
  MemoryItemView,
  MemoryTopicView,
  PersonView,
  PossibleMatch,
  ReviewMemoryItemInput,
  UpdateMemoryItemInput,
  Unsubscribe,
} from '@agent-desktop/public-contracts';
import type {
  AppSettingsResponse,
  BuiltinModelProviderList,
  ChatGPTLoginStartResult,
  ChatGPTLoginStatus,
  CompleteChatGPTLoginInput,
  CreateModelProviderInput,
  FeedbackInput,
  FeedPost,
  Id,
  Item,
  MacAppsResponse,
  ModelCatalog,
  ModelProvider,
  ModelProviderList,
  ResolveRequestInput,
  ResumeEntry,
  RunAgentInput,
  UpdateModelProviderInput,
  UpdateSettingsInput,
} from '@agent-desktop/public-contracts';

export * from '@agent-desktop/public-contracts';

/**
 * The owner's model providers (backend BACKEND.md §10.14, routes `/v1/model-providers*`). Keys are
 * write-only: responses carry `hasKey`, never the key. Public contracts v0.2.0 ship the schemas but
 * not this API surface, so the client declares it here until the shared `ApiClient` gains it.
 */
export interface ModelProvidersApi {
  list(): Promise<ModelProviderList>;
  builtin(): Promise<BuiltinModelProviderList>;
  create(input: CreateModelProviderInput): Promise<ModelProvider>;
  update(id: Id, patch: UpdateModelProviderInput): Promise<ModelProvider>;
  delete(id: Id): Promise<void>;
  /** The provider's model catalog; 503 MODEL_CATALOG_UNAVAILABLE when upstream is down. */
  models(id: Id): Promise<ModelCatalog>;
  /** Start a ChatGPT subscription sign-in (OpenAI only); valid for 10 minutes. */
  startChatGPTLogin(): Promise<ChatGPTLoginStartResult>;
  /** Finish it with the full callback URL the browser ended on (manual paste). */
  completeChatGPTLogin(input: CompleteChatGPTLoginInput): Promise<ModelProvider>;
  /** Where a sign-in stands; the desktop engine finishes it itself when the browser reaches its callback. */
  chatGPTLoginStatus(loginId: Id): Promise<ChatGPTLoginStatus>;
  /** Abandon a pending sign-in (the dialog closed). */
  cancelChatGPTLogin(loginId: Id): Promise<void>;
}

/** `GET`/`PATCH /v1/settings` also answer the fast and System One models background calls would use right now. */
export interface SettingsApi {
  get(): Promise<AppSettingsResponse>;
  update(patch: UpdateSettingsInput): Promise<AppSettingsResponse>;
  models(): Promise<ModelCatalog>;
}

/** The feed API with the whole feedback body (signal, reason, note) that contracts 0.19 accepts on the wire. */
export type FeedApi = Omit<PublicFeedApi, 'feedback'> & { feedback(id: Id, input: FeedbackInput): Promise<FeedPost> };

/** The 202 reply of the standard run entry: the stored user item when the input carried a turn. */
export interface AguiRunResult {
  runId: string;
  item?: Item;
}

/** Input for a standard resume segment; the route owns threadId and the server may replace runId. */
export interface AguiResumeInput {
  runId: string;
  resume: ResumeEntry[];
  messages?: RunAgentInput['messages'];
  state?: RunAgentInput['state'];
  tools?: RunAgentInput['tools'];
  context?: RunAgentInput['context'];
  forwardedProps?: RunAgentInput['forwardedProps'];
}

export interface AguiResumeDecision {
  requestId: Id;
  decision: ResolveRequestInput;
}

/**
 * Conversations with the AG-UI run entry. `send` and `resumeRequest` both go through
 * `POST /v1/conversations/:id/runs`; the old chat-events endpoint is not used.
 */
export interface AdmissionIdentity {
  messageId: Id;
  runId: Id;
}

/** One new send intent. Keep this identity when retrying a lost response. */
export function newAdmissionIdentity(): AdmissionIdentity {
  return { messageId: `msg-client-${crypto.randomUUID()}`, runId: newAguiRunId() };
}

export interface ConversationsApi extends PublicConversationsApi {
  send(id: Id, payload: Parameters<PublicConversationsApi['send']>[1], identity?: AdmissionIdentity): ReturnType<PublicConversationsApi['send']>;
  runAgent(id: Id, input: RunAgentInput): Promise<AguiRunResult>;
  resume(id: Id, input: AguiResumeInput): Promise<AguiRunResult>;
  /** Answer every still-pending interrupt of one segment in one standard resume batch. */
  resumeRequests(id: Id, decisions: AguiResumeDecision[], runId?: Id): Promise<AguiRunResult>;
  /** Resolve a segment's only pending interrupt; use resumeRequests for a batch. */
  resumeRequest(id: Id, requestId: Id, decision: ResolveRequestInput, runId?: Id): Promise<AguiRunResult>;
}

/** The standard resume entry for a typed product decision. A denial is `cancelled`; a decision is `resolved`. */
export function resumeEntryForDecision(requestId: Id, decision: ResolveRequestInput): ResumeEntry {
  if (decision.action === 'deny') return { interruptId: requestId, status: 'cancelled', payload: decision };
  return { interruptId: requestId, status: 'resolved', payload: decision };
}

/** A client hint for a fresh wire run; the server replaces it when it names the durable run itself. */
export function newAguiRunId(): string {
  return `run-client-${crypto.randomUUID()}`;
}

/** A live source that can tell the cache owner its replay window was reset. */
export interface EventResetSource {
  subscribeReset(listener: () => void): Unsubscribe;
}

/** The secret a routine's webhook trigger is called with; returned once, on mint or rotate (`POST /v1/routines/:id/webhook`). */
export interface RoutineWebhookSecret {
  url: string;
  secret: string;
}

/** Routines with the webhook secret endpoint, which the shared contracts do not declare yet. */
export interface RoutinesApiWithWebhook extends PublicRoutinesApi {
  /** Mint the first secret or rotate it; the previous secret stops working at once. */
  rotateWebhook(id: Id): Promise<RoutineWebhookSecret>;
}

/**
 * People and memory items (the owner's People and Memory segments, contract 0.60.0). The shapes come from the shared
 * contract; the endpoints below are the ones the backend serves. 503 on memory routes means memory is unavailable right now.
 */
export interface PeopleApi {
  /** `GET /v1/people?limit&cursor`, newest activity first. */
  list(params?: { limit?: number; cursor?: string }): Promise<ListResult<PersonView>>;
  /** `GET /v1/people/possible-matches`: accounts that may belong to a person. */
  possibleMatches(params?: { cursor?: string }): Promise<ListResult<PossibleMatch>>;
  /** `POST /v1/people/:id/link {accountId}`: link an account to a person. */
  link(personId: Id, accountId: Id): Promise<void>;
  /** `POST /v1/accounts/:id/unlink`: take an account off its person. */
  unlinkAccount(accountId: Id): Promise<void>;
  /** `PATCH /v1/people/:id {name}`. */
  rename(personId: Id, name: string): Promise<void>;
  /** `POST /v1/relations/:id/confirm`. */
  confirmRelation(relationId: Id): Promise<ConfirmRelationResult>;
  /** `DELETE /v1/relations/:id`. */
  deleteRelation(relationId: Id): Promise<void>;
}

export interface MemoryItemsApi {
  /** `GET /v1/memory/items?about&status&topic&cursor&limit`, one cursor page. */
  list(params?: { about?: Id; status?: MemoryItemStatus; topic?: MemoryItemTopic; cursor?: string; limit?: number }): Promise<ListResult<MemoryItemView>>;
  /** `GET /v1/memory/topics`: the topics that have items, in the fixed order, each with its summary (may be empty) and count. */
  topics(): Promise<{ items: MemoryTopicView[] }>;
  /** `GET /v1/memory/review`: the items waiting for the owner's review. */
  review(): Promise<{ items: MemoryItemView[] }>;
  /** `PATCH /v1/memory/items/:id`; an omitted `audience` keeps a group audience. */
  update(id: Id, patch: UpdateMemoryItemInput): Promise<void>;
  /** `DELETE /v1/memory/items/:id`. */
  delete(id: Id): Promise<void>;
  /** `POST /v1/memory/review/:id`: keep the item (optionally about a person) or delete it. */
  resolveReview(id: Id, input: ReviewMemoryItemInput): Promise<void>;
}

/**
 * What the client last saw of who holds a screen (`ScreenResponse.controlEpoch`). Sent as `x-expect-epoch`: when someone else changed
 * control since, the server does nothing, so a stale tap on Take over or Return never flips a screen the person did not mean to.
 */
export interface ControlOptions {
  expectEpoch?: number;
}

/** Computers with the control epoch on a screen's take-over and return (BACKEND 7.8b). */
export interface ComputersApi extends Omit<PublicComputersApi, 'takeOverScreen' | 'returnControlScreen'> {
  takeOverScreen(screenId: Id, options?: ControlOptions): Promise<ScreenResponse>;
  returnControlScreen(screenId: Id, options?: ControlOptions): Promise<ScreenResponse>;
}

export interface ApiClient extends Omit<PublicApiClient, 'settings' | 'feed' | 'routines' | 'conversations' | 'computers'> {
  computers: ComputersApi;
  conversations: ConversationsApi;
  settings: SettingsApi;
  feed: FeedApi;
  routines: RoutinesApiWithWebhook;
  modelProviders: ModelProvidersApi;
  people: PeopleApi;
  memoryItems: MemoryItemsApi;
  /**
   * Dictation: `POST /v1/transcriptions` with the raw recording as the body; resolves to the spoken text.
   * Errors: 503 TRANSCRIPTION_UNAVAILABLE, 415 UNSUPPORTED_AUDIO, 400 EMPTY_AUDIO, 413 AUDIO_TOO_LARGE, 502 TRANSCRIPTION_FAILED.
   */
  transcribe(audio: Blob): Promise<string>;
  /** The apps the owner let agents use on their Mac for good (`GET /v1/mac/apps`). */
  macApps(): Promise<MacAppsResponse>;
  /** Take one back (`DELETE /v1/mac/apps/:app`); 404 when it is not in the list. Resolves to the updated list. */
  revokeMacApp(app: string): Promise<MacAppsResponse>;
}
