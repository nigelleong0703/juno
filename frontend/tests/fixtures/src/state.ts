import type {
  AppSettings,
  Agent,
  AgentHomeFile,
  AgentTask,
  AuditEntry,
  Computer,
  Conversation,
  FeedPost,
  Goal,
  Idea,
  Item,
  LibraryItem,
  MemoryClaim,
  Plan,
  Plugin,
  Request,
  Routine,
  Space,
  Rule,
  Run,
  SecretMetadata,
  Skill,
  Usage,
} from '@agent-desktop/client';
import type { ModelProviderMockState } from './model-providers.js';

/** Entire in-memory world the mock API reads from and writes to. */
export interface MockState {
  agents: Agent[];
  computers: Computer[];
  conversations: Conversation[];
  /** conversationId → ordered items (oldest first). */
  items: Map<string, Item[]>;
  runs: Run[];
  plans: Plan[];
  tasks: AgentTask[];
  requests: Request[];
  routines: Routine[];
  rules: Rule[];
  audit: AuditEntry[];
  memoryClaims: MemoryClaim[];
  /** The user's /juno home files: agent persona files, USER.md, ALIGNMENT_SYNTHESIS.md. */
  home: AgentHomeFile[];
  goals: Goal[];
  ideas: Idea[];
  feedPosts: FeedPost[];
  skills: Skill[];
  plugins: Plugin[];
  secrets: SecretMetadata[];
  library: LibraryItem[];
  /** Published apps (BACKEND §5.12) with the status the passive check would report. */
  spaces: Space[];
  usage: Usage;
  settings: AppSettings;
  modelProviders: ModelProviderMockState;
}

export const emptyState = (): MockState => ({
  agents: [],
  computers: [],
  conversations: [],
  items: new Map(),
  runs: [],
  plans: [],
  tasks: [],
  requests: [],
  routines: [],
  rules: [],
  audit: [],
  memoryClaims: [],
  home: [],
  goals: [],
  ideas: [],
  feedPosts: [],
  skills: [],
  plugins: [],
  secrets: [],
  library: [],
  spaces: [],
  usage: {
    week: {
      start: new Date(0).toISOString(),
      end: new Date(0).toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      computeSeconds: 0,
      costUsd: 0,
      limitUsd: 0,
      percent: 0,
    },
    byAgent: [],
    byApp: [],
  },
  settings: {
    general: { launchAtLogin: false, language: 'en' },
    appearance: { theme: 'dark', density: 'comfortable', accent: 'violet' },
    notifications: [],
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: { serverUrl: '', modelProviders: [] },
    privacy: { dataRetentionDays: 30, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
  },
  modelProviders: { providers: [], platformDefault: true },
});
