import type {
  AgentsListParams,
  IdeasListParams,
  ConversationsListParams,
  LibraryListParams,
  PluginsListParams,
  RequestsListParams,
  RoutinesListParams,
  AuditListParams,
  FeedListParams,
  GoalsListParams,
  RulesListParams,
  RunsListParams,
  SkillsListParams,
} from "@agent-desktop/client";

/**
 * Central query-key factory. Every cache entry is addressed through here so `liveSync`
 * can update the right slices by prefix (ARCHITECTURE §7).
 */
export const qk = {
  agents: (params?: AgentsListParams) => ["agents", params ?? {}] as const,
  agent: (id: string) => ["agent", id] as const,

  conversations: (params?: ConversationsListParams) => ["conversations", params ?? {}] as const,
  conversation: (id: string) => ["conversation", id] as const,
  items: (conversationId: string) => ["items", conversationId] as const,

  runs: (params?: RunsListParams) => ["runs", params ?? {}] as const,
  run: (id: string) => ["run", id] as const,

  requests: (params?: RequestsListParams) => ["requests", params ?? {}] as const,
  ideas: (params?: IdeasListParams) => ["ideas", params ?? {}] as const,
  request: (id: string) => ["request", id] as const,

  routines: (params?: RoutinesListParams) => ["routines", params ?? {}] as const,
  routine: (id: string) => ["routine", id] as const,

  calendar: (from: string, to: string, agentId?: string) => ["calendar", from, to, agentId ?? "all"] as const,

  goals: (params?: GoalsListParams) => ["goals", params ?? {}] as const,
  goal: (id: string) => ["goal", id] as const,
  feed: (params?: FeedListParams) => ["feed", params ?? {}] as const,
  /** The Today summary (greeting hour, needs-you, working, brief). */
  today: () => ["today"] as const,

  computers: () => ["computers"] as const,
  myMac: () => ["my-mac"] as const,
  macApps: () => ["mac-apps"] as const,
  computerRuntime: () => ["computer-runtime"] as const,
  computer: (id: string) => ["computer", id] as const,
  screens: (computerId: string) => ["screens", computerId] as const,
  screen: (computerId: string, agentId: string) => ["screen", computerId, agentId] as const,
  screenStream: (screenId: string, control: boolean) =>
    ["screen-stream", screenId, control ? "control" : "watch"] as const,

  members: () => ["members"] as const,
  usage: () => ["usage"] as const,
  /** A document and its open draft (without the Markdown). */
  document: (id: string) => ["document", id] as const,
  documentDraft: (id: string) => ["document-draft", id] as const,
  documentVersion: (id: string, version: number) => ["document-version", id, version] as const,
  settings: () => ["settings"] as const,
  profile: () => ["profile"] as const,
  modelProviders: () => ["model-providers"] as const,
  builtinProviders: () => ["model-providers", "builtin"] as const,
  platformModels: () => ["model-providers", "platform-models"] as const,
  providerModels: (id: string) => ["model-providers", "models", id] as const,
  library: (params?: LibraryListParams) => ["library", params ?? {}] as const,
  skills: (params?: SkillsListParams) => ["skills", params ?? {}] as const,
  memoryClaims: () => ["memory", "claims"] as const,
  memorySearch: (query: string) => ["memory", "search", query] as const,
  home: (prefix: string) => ["home", prefix] as const,
  rules: (params?: RulesListParams) => ["rules", params ?? {}] as const,
  proactiveRules: () => ["proactive-rules"] as const,
  delegations: (agentId?: string) => (agentId ? (["delegations", agentId] as const) : (["delegations"] as const)),
  plugins: (params?: PluginsListParams) => ["plugins", params ?? {}] as const,
  audit: (params?: AuditListParams) => ["audit", params ?? {}] as const,
} as const;

/** Prefix matchers used by `liveSync` to fan an event out to every cached variant. */
export const prefix = {
  agents: ["agents"] as const,
  agent: ["agent"] as const,
  conversations: ["conversations"] as const,
  conversation: ["conversation"] as const,
  items: ["items"] as const,
  runs: ["runs"] as const,
  run: ["run"] as const,
  requests: ["requests"] as const,
  request: ["request"] as const,
  routines: ["routines"] as const,
  routine: ["routine"] as const,
  calendar: ["calendar"] as const,
  goals: ["goals"] as const,
  goal: ["goal"] as const,
  feed: ["feed"] as const,
  computers: ["computers"] as const,
  computer: ["computer"] as const,
  screens: ["screens"] as const,
  screen: ["screen"] as const,
  screenStream: ["screen-stream"] as const,
};
