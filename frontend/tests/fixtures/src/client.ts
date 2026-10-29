import type {
  AgentCalendarItem,
  AgentTask,
  AppSettingsResponse,
  EffectiveSystemOneModel,
  EffectiveTier,
  EffectiveTiers,
  TierName,
  Tiers,
  AgentsListParams,
  ComputersListParams,
  ConversationsListParams,
  FeedListParams,
  GoalsListParams,
  IdeasListParams,
  ItemsListParams,
  LibraryListParams,
  PluginsListParams,
  RequestsListParams,
  RoutinesListParams,
  RunsListParams,
  RulesListParams,
  AuditListParams,
  Skill,
  SkillsListParams,
  SkillVersion,
  UpdateSkillInput,
  CreateDelegationInput,
  MacStatus,
  ProactiveRule,
} from '@agent-desktop/client';
import type { ApiClient } from '@agent-desktop/client';
import type {
  AgentEvent,
  AguiResumeDecision,
  AguiResumeInput,
  AguiRunResult,
  EventHandler,
  EventResetSource,
  EventSource,
  JunoEventMetadata,
  Message,
  ResolveRequestInput,
  ResumeEntry,
  RunAgentInput,
  SecureVaultKeys,
  Unsubscribe,
} from '@agent-desktop/client';
import { EventType } from '@agent-desktop/client';
import type {
  Agent,
  AgentHomeFile,
  AgentStatus,
  AuditEntry,
  Computer,
  ComputerScreen,
  ComposerPayload,
  Conversation,
  FeedPost,
  Inspiration,
  FileDownload,
  Goal,
  Idea,
  Item,
  LibraryItem,
  ModelCatalog,
  PlanItem,
  Request,
  Routine,
  Rule,
  Run,
  ScreenResponse,
  Step,
  StepKind,
  ToolPermission,
} from '@agent-desktop/client';
import type { MockState } from './state.js';
import { deriveRequestOutcome, putProfileInputSchema, updateAgentInputSchema } from '@agent-desktop/client';
import type { Profile } from '@agent-desktop/client';
import {
  at,
  createIdFactory,
  createRng,
  iso,
  mustFind,
  paginate,
  apiError,
  removeById,
  systemNow,
  upsertById,
  type NowFn,
} from './util.js';
import { SHARED_COMPUTER_ID, buildWorld, refreshConversation } from './world.js';
import { mockArtifactDownload, mockRenderUrl } from './artifact-bytes.js';
import { createAppsMock } from './apps.js';
import { createDocumentsMock } from './documents.js';
import { createModelProvidersMock, providerCatalog } from './model-providers.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface MockClientOptions {
  /** Simulation speed multiplier (1 = a tick every 2.6s). */
  speed?: number;
  /** Seed for the deterministic RNG used by ids/timestamps. */
  seed?: number;
  /** Simulated network delay in ms for every API call (0 = immediate). */
  latencyMs?: number;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  clock?: NowFn;
  /** Open ideas the world starts with (the prototype's sample offers); `reset()` restores them. */
  ideas?: Idea[];
  /** Whether the platform default model endpoint exists (default true); false makes a fresh world unusable until a provider is added. */
  platformDefault?: boolean;
}

export interface MockClient extends ApiClient, EventSource, EventResetSource {
  /** Rebuild the world from scratch (fresh simulation). */
  reset(): void;
  /** Stop the live simulation (keeps emitting nothing until resumed). */
  pause(): void;
  /** Resume the live simulation. */
  resume(): void;
  isPaused(): boolean;
  now(): number;
  setSpeed(speed: number): void;
  /** Test aid: run `times` simulation ticks synchronously, ignoring the pause flag. */
  advance(times?: number): void;
  /** Test aid: the paired Mac's link goes up or down (no effect while no Mac is paired). */
  setMyMacOnline(online: boolean): void;
  /** Test aid: the person resumed the stopped Mac on the Mac itself (the only way back; clients have no Resume). */
  resumeMyMac(): void;
  /** The id after the newest emitted event; pass it back to `replaySince`. */
  cursor(): number;
  /** The events emitted after `cursor`, as the stream's backlog replay would deliver them. */
  replaySince(cursor: number | null): AgentEvent[];
  /** Test aid: the `MESSAGES_SNAPSHOT` a reconnect synthesizes for one conversation. */
  snapshot(conversationId: string): AgentEvent;
  /** Test aid: a reconnect; emits the conversation's snapshot. */
  reconnect(conversationId: string): void;
  /** Notified when the replay window is reset (the next replay starts from the beginning). */
  subscribeReset(listener: () => void): Unsubscribe;
}

const BASE_TICK_MS = 2600;
const MINUTE = 60_000;
const LIVE_RUN_ID = 'run-live';
const LIVE_RUN_AGENT_ID = 'agent-juno';
const LIVE_APPROVAL_ID = 'req-live-approval';
const BLANK_AGENT_TITLE = 'New agent';
const SETUP_REQUEST_PREFIX = 'req-setup-';
const SETUP_GREETING =
  'Hi — I’m your new agent. What should I take care of? Tell me what you need and I’ll set myself up (name, look, apps, and a first routine).';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';

/** The home file each persona field of a create input lands in. */
const PERSONA_FILES = { personality: 'IDENTITY.md', principles: 'SOUL.md', instructions: 'AGENTS.md', toolNotes: 'TOOLS.md' } as const;

const AVATAR_BY_LABEL: Record<string, Agent['avatar']['shape']> = {
  Circle: 'circle',
  Triangle: 'triangle',
  Diamond: 'diamond',
  Hexagon: 'hexagon',
  Squircle: 'squircle',
  Blob: 'blob',
};

const PLUGINS_BY_FOCUS: Record<string, string[]> = {
  'Research & inbox': ['plugin-gmail', 'plugin-google-calendar', 'plugin-google-drive', 'plugin-notion'],
  'Engineering & CI': ['plugin-github', 'plugin-linear', 'plugin-slack'],
  'Finance & expenses': ['plugin-stripe', 'plugin-gmail'],
  'Meetings & notes': ['plugin-google-calendar', 'plugin-notion', 'plugin-slack'],
  'Recruiting & network': ['plugin-gmail', 'plugin-slack', 'plugin-notion'],
  'Travel & calendar': ['plugin-google-calendar', 'plugin-google-drive', 'plugin-slack'],
};

interface StepTemplate {
  kind: StepKind;
  verb: string;
  target: string;
  output?: { summary?: string; text?: string };
  screenshot?: boolean;
}

const PRE_APPROVAL_STEPS: StepTemplate[] = [
  { kind: 'browser', verb: 'Opened', target: 'mail.google.com → Inbox', screenshot: true },
  { kind: 'mcp', verb: 'Called gmail.draft_reply on', target: '3 Action threads' },
  { kind: 'file', verb: 'Wrote', target: '/workspace/inbox/drafts.md', output: { summary: '3 drafts saved' } },
];

const POST_APPROVAL_STEPS: StepTemplate[] = [
  { kind: 'think', verb: 'Summarized', target: '12 Action threads for you' },
  { kind: 'mcp', verb: 'Called slack.post_message →', target: '#research', output: { summary: 'Digest posted' } },
];

// ---------------------------------------------------------------------------

class EventBus {
  private handlers = new Set<EventHandler>();
  private resetHandlers = new Set<() => void>();
  private log: Array<{ id: number; event: AgentEvent }> = [];
  private nextId = 1;

  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  subscribeReset(listener: () => void): Unsubscribe {
    this.resetHandlers.add(listener);
    return () => {
      this.resetHandlers.delete(listener);
    };
  }

  size(): number {
    return this.handlers.size;
  }

  emit(event: AgentEvent): void {
    this.log.push({ id: this.nextId, event });
    this.nextId += 1;
    if (this.log.length > 500) this.log.shift();
    for (const handler of Array.from(this.handlers)) handler(event);
  }

  cursor(): number {
    return this.nextId - 1;
  }

  replaySince(cursor: number | null): AgentEvent[] {
    const after = cursor ?? 0;
    return this.log.filter((entry) => entry.id > after).map((entry) => entry.event);
  }

  /** The server can no longer replay from the client's cursor: forget the backlog and tell listeners. */
  resetReplay(): void {
    this.log = [];
    this.nextId = 1;
    for (const listener of Array.from(this.resetHandlers)) listener();
  }
}

export function createMockClient(opts: MockClientOptions = {}): MockClient {
  const seed = opts.seed ?? 7;
  const clock: NowFn = opts.clock ?? systemNow;
  const latencyMs = opts.latencyMs ?? 0;
  const seedIdeas = opts.ideas ?? [];
  const platformDefault = opts.platformDefault ?? true;
  const withSeedIdeas = (world: MockState): MockState => ({
    ...world,
    ideas: seedIdeas.map((idea) => ({ ...idea })),
    modelProviders: { providers: [], platformDefault },
  });

  let speed = opts.speed ?? 1;
  let rng = createRng(seed);
  let idFactory = createIdFactory('gen', rng);
  let state: MockState = withSeedIdeas(buildWorld(clock(), seed));
  let mac: MacStatus = { paired: false, online: false };
  /** The control epoch per surface (a screen id, or `mac`): bumped on every change of who holds it. */
  const controlEpochs = new Map<string, number>();

  const bus = new EventBus();
  let paused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickIndex = 0;
  let phase: 'pre' | 'await' | 'post' | 'done' = 'pre';
  let preCursor = 0;
  let postCursor = 0;
  /** Replies a started run will commit on a later tick; a stop removes them, so no text arrives after it. */
  let pendingReplies: Array<{ runId: string; text: string; dueTick: number }> = [];

  const now = (): number => clock();
  const emit = (event: AgentEvent): void => bus.emit(event);

  // --- AG-UI wire helpers ---------------------------------------------------
  // Standard events carry the chat lifecycle (docs/architecture/AGUI-MIGRATION.md); Juno
  // attribution rides in metadata.juno and product events keep their old names.
  const AGUI_PROTOCOL_VERSION = '1.0';
  const threadOf = (run: Run): string => run.conversationId ?? run.id;
  const runMetadata = (run: Run): { juno: JunoEventMetadata } => ({
    juno: {
      agentId: run.agentId,
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      runId: run.id,
      runStatus: run.status,
    },
  });
  const stepNameOf = (step: Step): string => `${step.verb} ${step.target}`;

  const emitRunStarted = (run: Run): void => {
    emit({
      type: EventType.RUN_STARTED,
      threadId: threadOf(run),
      runId: run.id,
      protocolVersion: AGUI_PROTOCOL_VERSION,
      metadata: runMetadata(run),
    });
  };
  const emitRunUpdated = (run: Run): void => {
    emit({ type: EventType.CUSTOM, name: 'juno.run.updated', value: { ...run }, metadata: runMetadata(run) });
  };
  const emitRunFinished = (run: Run, outcome: { type: 'success' } | { type: 'cancelled' }): void => {
    emit({
      type: EventType.RUN_FINISHED,
      threadId: threadOf(run),
      runId: run.id,
      outcome,
      metadata: runMetadata(run),
    });
  };
  const emitRunInterrupted = (run: Run, request: Request): void => {
    emit({
      type: EventType.RUN_FINISHED,
      threadId: threadOf(run),
      runId: run.id,
      outcome: {
        type: 'interrupt',
        interrupts: [
          {
            id: request.id,
            reason: request.kind === 'question' ? 'question' : 'approval',
            message: request.title,
            metadata: {
              juno: {
                requestId: request.id,
                agentId: run.agentId,
                ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
              },
            },
          },
        ],
      },
      metadata: runMetadata(run),
    });
  };
  const emitStepStarted = (run: Run, step: Step): void => {
    emit({
      type: EventType.STEP_STARTED,
      stepName: stepNameOf(step),
      metadata: { juno: { runId: run.id, stepId: step.id } },
    });
  };
  const emitStepFinished = (run: Run, step: Step): void => {
    emit({
      type: EventType.STEP_FINISHED,
      stepName: stepNameOf(step),
      metadata: { juno: { runId: run.id, stepId: step.id } },
    });
  };

  /** A committed agent reply: the authoritative text message and the transcript item, under one id. */
  const emitAuthoritativeReply = (item: Item): void => {
    if (item.type !== 'agent_message') return;
    const run = state.runs.find(
      (candidate) => candidate.conversationId === item.conversationId && candidate.agentId === item.agentId,
    );
    const metadata = {
      juno: {
        agentId: item.agentId,
        conversationId: item.conversationId,
        ...(run === undefined ? {} : { runId: run.id }),
      },
    };
    emit({ type: EventType.TEXT_MESSAGE_START, messageId: item.id, role: 'assistant', metadata });
    emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: item.id, delta: item.markdown, metadata });
    emit({ type: EventType.TEXT_MESSAGE_END, messageId: item.id, metadata });
  };

  /** The messages a standard client rebuilds a conversation from (user turns and committed replies). */
  const messagesOf = (conversationId: string): Message[] => {
    const messages: Message[] = [];
    for (const item of state.items.get(conversationId) ?? []) {
      // The whole item rides along so a client can restore its exact row; the visible role/content
      // keeps the message a standard AG-UI message on its own.
      if (item.type === 'user_message') {
        messages.push({
          id: item.id,
          role: 'user',
          content: item.text,
          metadata: { juno: { conversationId, authorId: item.authorId, item } },
        });
      } else if (item.type === 'agent_message') {
        messages.push({
          id: item.id,
          role: 'assistant',
          content: item.markdown,
          metadata: { juno: { conversationId, agentId: item.agentId, item } },
        });
      }
    }
    return messages;
  };

  const snapshotOf = (conversationId: string): AgentEvent => ({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: messagesOf(conversationId),
    metadata: { juno: { conversationId } },
  });

  const delay = (): Promise<void> =>
    latencyMs > 0 ? new Promise((resolve) => setTimeout(() => resolve(), latencyMs)) : Promise.resolve();

  // --- lookups -------------------------------------------------------------
  const agentOf = (id: string): Agent => mustFind(state.agents, id, 'agent');

  /** Create or replace a home file the way the backend does: a new hash on every write, an event for the app. */
  const putHomeFile = (path: string, content: string, writer: AgentHomeFile['writer'] = 'user'): AgentHomeFile => {
    const file: AgentHomeFile = { path, content, hash: idFactory(), writer, updatedAt: iso(now()) };
    state.home = [...state.home.filter((f) => f.path !== path), file];
    emit({ type: 'agent.home.changed', path });
    return file;
  };

  /** A freshly created agent has a default avatar, no role yet and no identity file. */
  const isBlankAgent = (agent: Agent): boolean =>
    agent.title === BLANK_AGENT_TITLE && !state.home.some((f) => f.path === `agents/${agent.id}/IDENTITY.md`);
  const runOf = (id: string): Run => mustFind(state.runs, id, 'run');
  const convOf = (id: string): Conversation => mustFind(state.conversations, id, 'conversation');

  const directConversationFor = (agentId: string): Conversation | undefined =>
    state.conversations.find((c) => c.kind === 'direct' && c.agentIds.includes(agentId));

  const postItem = (item: Item): Item => {
    const list = state.items.get(item.conversationId) ?? [];
    list.push(item);
    state.items.set(item.conversationId, list);
    refreshConversation(state, item.conversationId);
    emit({ type: 'item.added', conversationId: item.conversationId, item });
    // A committed agent reply is also the authoritative AG-UI text message.
    emitAuthoritativeReply(item);
    return item;
  };

  const setAgentStatus = (agentId: string, status: AgentStatus): void => {
    const agent = agentOf(agentId);
    agent.status = status;
    emit({ type: 'agent.status', agentId, status });
  };

  const addAudit = (entry: Omit<AuditEntry, 'id'>): AuditEntry => {
    const full: AuditEntry = { id: idFactory(), ...entry };
    state.audit.unshift(full);
    return full;
  };

  // --- blank-agent setup (v0.3: agents are user-created chat contacts) -------
  const setupFieldIds = {
    name: 'setup-name',
    avatar: 'setup-avatar',
    focus: 'setup-focus',
    routine: 'setup-routine',
  } as const;

  /** Reply to a blank agent's first message with a setup proposal (agent_message + question request). */
  const proposeSetup = (agent: Agent, conversation: Conversation): void => {
    postItem({
      id: idFactory(),
      conversationId: conversation.id,
      at: iso(now()),
      type: 'agent_message',
      agentId: agent.id,
      markdown: [
        'Happy to help. Before I start, here’s what I’d suggest for me:',
        '',
        '- **Name** — whatever you’d like to call me',
        '- **Look** — pick an avatar shape',
        '- **Focus** — the kind of work I should take on',
        '- **First routine** — something I can run on a schedule',
        '',
        'Answer below and I’ll set myself up.',
      ].join('\n'),
      citations: [],
    });
    const request: Request = {
      id: `${SETUP_REQUEST_PREFIX}${idFactory()}`,
      kind: 'question',
      status: 'pending',
      title: `Set up ${agent.name}`,
      summary: 'Confirm my name, look, focus and first routine.',
      agentId: agent.id,
      conversationId: conversation.id,
      createdAt: iso(now()),
      payload: {
        kind: 'question',
        ui: {
          version: 1,
          title: `Set up ${agent.name}`,
          blocks: [
            {
              type: 'fields',
              id: 'setup',
              fields: [
                { id: setupFieldIds.name, label: 'What should I be called?', kind: 'text' },
                { id: setupFieldIds.avatar, label: 'Pick a look', kind: 'select', options: Object.keys(AVATAR_BY_LABEL) },
                { id: setupFieldIds.focus, label: 'What should I focus on?', kind: 'select', options: Object.keys(PLUGINS_BY_FOCUS) },
                { id: setupFieldIds.routine, label: 'A first routine?', kind: 'select', options: ['Daily inbox triage', 'PR review sweep', 'Daily standup draft', 'None yet'] },
              ],
            },
          ],
        },
      },
    };
    state.requests.unshift(request);
    emit({ type: 'request.created', request });
    // The transcript shows the request too, so the app doesn't have to synthesize it.
    postItem({ id: idFactory(), conversationId: conversation.id, at: request.createdAt, type: 'request', requestId: request.id });
  };

  /** Apply a resolved setup proposal: rename/re-avatar/re-focus the agent and emit `agent.updated`. */
  const applySetup = (request: Request, answers: Record<string, string>): void => {
    const agent = state.agents.find((a) => a.id === request.agentId);
    if (!agent) return;

    const name = answers[setupFieldIds.name]?.trim();
    const avatarLabel = answers[setupFieldIds.avatar];
    const focus = answers[setupFieldIds.focus];
    const routineLabel = answers[setupFieldIds.routine];
    const shape = avatarLabel ? AVATAR_BY_LABEL[avatarLabel] : undefined;

    if (name) {
      agent.name = name;
      agent.handle = slugify(name);
    }
    if (shape) {
      agent.avatar = { ...agent.avatar, shape };
    }
    if (focus) {
      agent.title = focus;
      putHomeFile(`agents/${agent.id}/IDENTITY.md`, `Focused on ${focus.replace(' & ', ' and ').toLowerCase()}.`);
      agent.pluginIds = PLUGINS_BY_FOCUS[focus] ?? agent.pluginIds;
    }
    agent.lastActivity = 'Set up just now';
    agent.updatedAt = iso(now());
    emit({ type: 'agent.updated', agent: { ...agent } });

    const conv = directConversationFor(agent.id);
    if (conv) conv.title = agent.name;

    if (routineLabel && routineLabel !== 'None yet') {
      const routine: Routine = {
        id: idFactory(),
        agentId: agent.id,
        name: routineLabel,
        instructions: `Run “${routineLabel}” for ${agent.name}.`,
        trigger: { kind: 'schedule', cron: '0 9 * * 1-5', human: 'Weekdays 9:00 (Asia/Singapore)', tz: 'Asia/Singapore' },
        delivery: { channel: 'chat' },
        notify: { mode: 'on_failure', channel: 'desktop' },
        enabled: true,
        status: 'active',
        nextRunAt: iso(now() + 60 * 60 * 1000),
        runs: [],
        createdAt: iso(now()),
      };
      state.routines.push(routine);
      emit({ type: 'routine.updated', routine: { ...routine } });
    }

    if (conv) {
      postItem({
        id: idFactory(),
        conversationId: conv.id,
        at: iso(now()),
        type: 'agent_message',
        agentId: agent.id,
        markdown: `All set — I’m ${agent.name}, focused on ${agent.title.toLowerCase()}. Ask me for anything${
          routineLabel && routineLabel !== 'None yet' ? `, and I’ll keep the “${routineLabel}” routine running` : ''
        }.`,
        citations: [],
      });
    }
  };

  // --- live simulation -----------------------------------------------------
  const makeStep = (run: Run, template: StepTemplate): Step => {
    const index = run.steps.length;
    const step: Step = {
      id: `${run.id}-sim-${index}`,
      runId: run.id,
      index,
      kind: template.kind,
      verb: template.verb,
      target: template.target,
      screenshotRef: template.screenshot ? `shot-${run.agentId}-sim-${index}` : undefined,
      output: template.output,
      status: 'completed',
      startedAt: iso(now()),
      durationMs: 900 + index * 120,
    };
    run.steps.push(step);
    run.usage.steps = run.steps.length;
    run.usage.outputTokens += 420;
    run.usage.inputTokens += 1800;
    return step;
  };

  const emitStepUpdated = (run: Run): void => {
    const last = run.steps[run.steps.length - 1];
    if (!last) return;
    last.durationMs += 350;
    run.lastActivityAt = iso(now());
    emitStepFinished(run, last);
    emitRunUpdated(run);
  };

  const emitStepAdded = (run: Run, template: StepTemplate): void => {
    const step = makeStep(run, template);
    run.lastActivityAt = iso(now());
    emitStepStarted(run, step);
    emitRunUpdated(run);
  };

  const createLiveApproval = (run: Run): void => {
    phase = 'await';
    run.status = 'waiting_for_input';
    run.lastActivityAt = iso(now());
    const request: Request = {
      id: LIVE_APPROVAL_ID,
      kind: 'approval',
      status: 'pending',
      title: 'Create a Linear issue for the sandbox follow-ups',
      summary: 'Juno wants to open LIN-518 “Sandbox decision follow-ups” in Linear.',
      agentId: run.agentId,
      conversationId: run.conversationId,
      runId: run.id,
      triggeringRuleId: 'rule-linear-ask',
      createdAt: iso(now()),
      payload: {
        kind: 'approval',
        action: 'Create issue',
        target: 'LIN-518 · Sandbox decision follow-ups',
        app: 'Linear',
        site: 'linear.app',
        why: 'The triage surfaced two follow-ups from the sandbox decision that need tracking.',
      },
    };
    state.requests.unshift(request);
    emitRunUpdated(run);
    emitRunInterrupted(run, request);
    emit({ type: 'request.created', request });
    // The transcript shows the request too, so the app doesn't have to synthesize it.
    if (request.conversationId) {
      postItem({ id: idFactory(), conversationId: request.conversationId, at: request.createdAt, type: 'request', requestId: request.id });
    }
    setAgentStatus(run.agentId, 'needs_you');
  };

  const finishLiveRun = (run: Run): void => {
    phase = 'done';
    run.status = 'completed';
    run.finishedAt = iso(now());
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    run.lastActivityAt = run.finishedAt;
    setAgentStatus(run.agentId, 'idle');
    const agent = agentOf(run.agentId);
    postItem({
      id: idFactory(),
      conversationId: run.conversationId ?? 'conv-juno',
      at: iso(now()),
      type: 'agent_message',
      agentId: run.agentId,
      markdown: `Triage done — 37 threads sorted, 12 need your attention. I opened LIN-518 for the sandbox follow-ups.`,
      citations: [],
    });
    agent.lastActivity = 'Finished the inbox triage sweep';
    emitRunFinished(run, { type: 'success' });
  };

  /** Commit a run's reply: the authoritative text and item, then success. */
  const commitReply = (run: Run, text: string): void => {
    if (run.status !== 'running') return;
    postItem({
      id: idFactory(),
      conversationId: run.conversationId ?? run.id,
      at: iso(now()),
      type: 'agent_message',
      agentId: run.agentId,
      markdown: text,
      citations: [],
    });
    run.status = 'completed';
    run.finishedAt = iso(now());
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    run.lastActivityAt = run.finishedAt;
    setAgentStatus(run.agentId, 'idle');
    emitRunFinished(run, { type: 'success' });
  };

  const runTick = (): void => {
    tickIndex += 1;
    const due = pendingReplies.filter((reply) => reply.dueTick <= tickIndex);
    pendingReplies = pendingReplies.filter((reply) => reply.dueTick > tickIndex);
    for (const reply of due) {
      const run = state.runs.find((candidate) => candidate.id === reply.runId);
      if (run) commitReply(run, reply.text);
    }
    // Occasional ambient events so the UI always has something moving.
    if (tickIndex % 6 === 0) {
      // The live run's agent is the one driving the shared screen.
      const activeRun = state.runs.find((r) => r.id === LIVE_RUN_ID);
      if (activeRun) {
        const computer = state.computers.find((c) => c.agentIds.includes(activeRun.agentId));
        if (computer) {
          computer.activeAgentId = activeRun.agentId;
          computer.resources.cpu.used = 20 + ((tickIndex * 7) % 55);
          computer.resources.memory.used = 3000 + ((tickIndex * 53) % 1800);
          computer.uptimeSeconds += 3;
          computer.lastUpdatedAt = iso(now());
          emit({ type: 'computer.state', computerId: computer.id, state: computer.state, controller: computer.controller });
        }
      }
    }
    if (tickIndex % 9 === 0) {
      const routine = state.routines.find((r) => r.id === 'routine-weekly-digest');
      if (routine) {
        routine.nextRunAt = iso(now() + 60 * 60 * 1000);
        emit({ type: 'routine.updated', routine: { ...routine, runs: [...routine.runs] } });
      }
    }

    // Ambient activity for the other agents (v0.3): their status flips and their
    // chat rows get a fresh last message, so the chat list feels alive.
    if (tickIndex % 5 === 0) {
      const others = state.agents.filter((a) => a.id !== LIVE_RUN_AGENT_ID);
      const agent = others[Math.floor(tickIndex / 5 - 1) % others.length];
      if (agent) {
        const next: AgentStatus = agent.status === 'working' ? 'idle' : 'working';
        agent.lastActivity = next === 'working' ? 'Working on a background task' : 'Idle — waiting for you';
        setAgentStatus(agent.id, next);
      }
    }
    if (tickIndex % 7 === 0) {
      const ambients: ReadonlyArray<readonly [string, string, string]> = [
        ['conv-patch', 'agent-patch', 'CI is green on the latest commit — nothing blocking.'],
        ['conv-ledger', 'agent-ledger', 'Watching the Stripe key request; nothing else needs you.'],
        ['conv-echo', 'agent-echo', 'Filed one more follow-up from the launch notes.'],
        ['conv-scout', 'agent-scout', 'One more candidate replied — adding them to the pipeline.'],
        ['conv-atlas', 'agent-atlas', 'Checked two more Lisbon venues; the shortlist is unchanged.'],
      ];
      const pick = ambients[Math.floor(tickIndex / 7 - 1) % ambients.length];
      if (pick && state.conversations.some((c) => c.id === pick[0])) {
        const [conversationId, agentId, text] = pick;
        const agent = state.agents.find((a) => a.id === agentId);
        if (agent) agent.lastActivity = text;
        postItem({ id: idFactory(), conversationId, at: iso(now()), type: 'agent_message', agentId, markdown: text, citations: [] });
      }
    }

    const run = state.runs.find((r) => r.id === LIVE_RUN_ID);
    if (!run) return;
    if (run.status === 'queued') {
      run.status = 'running';
      emitRunUpdated(run);
    }
    if (run.status !== 'running') return;

    const odd = tickIndex % 2 === 1;
    if (phase === 'pre') {
      if (odd && run.steps.length > 0) emitStepUpdated(run);
      else if (preCursor < PRE_APPROVAL_STEPS.length) emitStepAdded(run, at(PRE_APPROVAL_STEPS, preCursor++));
      else createLiveApproval(run);
    } else if (phase === 'post') {
      if (odd && run.steps.length > 0) emitStepUpdated(run);
      else if (postCursor < POST_APPROVAL_STEPS.length) emitStepAdded(run, at(POST_APPROVAL_STEPS, postCursor++));
      else finishLiveRun(run);
    }
  };

  const intervalMs = (): number => Math.max(40, Math.round(BASE_TICK_MS / speed));

  const ensureTimer = (): void => {
    if (timer !== null || paused || bus.size() === 0) return;
    timer = setInterval(() => {
      if (!paused) runTick();
    }, intervalMs());
  };

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const resetSim = (): void => {
    tickIndex = 0;
    phase = 'pre';
    preCursor = 0;
    postCursor = 0;
  };

  // -------------------------------------------------------------------------
  // Resource implementations
  // -------------------------------------------------------------------------

  const agents: ApiClient['agents'] = {
    async list(params = {} as AgentsListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.agents, {
        params: p,
        predicate: (a) =>
          (p.status === undefined || a.status === p.status) &&
          (p.section === undefined || a.section === p.section) &&
          (p.pinned === undefined || a.pinned === p.pinned),
        searchText: (a) => `${a.name} ${a.handle} ${a.title}`,
        defaultSort: { key: 'name', order: 'asc' },
      });
    },
    async get(id) {
      await delay();
      return { ...agentOf(id) };
    },
    async tasks(id) {
      await delay();
      agentOf(id);
      const rank = (t: AgentTask): number => (t.status !== 'ended' ? 0 : 1);
      const items = state.tasks
        .filter((t) => t.agentId === id)
        .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50);
      return { items: items.map((t) => ({ ...t })), nextCursor: null };
    },
    async plans(id) {
      await delay();
      const agent = agentOf(id);
      const conversationIds = new Set(
        state.conversations.filter((conv) => conv.agentIds.includes(agent.id)).map((conv) => conv.id),
      );
      // Mirror the real endpoint: the canonical plan wins its conversation, a legacy plan is
      // attributed by its bound run and only fills a conversation the canonical plan does not own.
      const canonical = new Map<string, PlanItem>();
      const legacy = new Map<string, PlanItem>();
      for (const [conversationId, items] of state.items) {
        if (!conversationIds.has(conversationId)) continue;
        for (const item of items) {
          if (item.type !== 'plan') continue;
          if (item.agentId === agent.id) {
            const current = canonical.get(conversationId);
            if (!current || item.at >= current.at) canonical.set(conversationId, item);
            continue;
          }
          if (item.agentId !== undefined) continue;
          const runAgent = state.runs.find((run) => run.id === item.runId)?.agentId;
          if (runAgent !== agent.id) continue;
          const current = legacy.get(conversationId);
          if (!current || item.at >= current.at) legacy.set(conversationId, item);
        }
      }
      const plans = new Map(canonical);
      for (const [conversationId, plan] of legacy) {
        if (!plans.has(conversationId)) plans.set(conversationId, { ...plan, agentId: agent.id });
      }
      const ordered = [...plans.values()].sort((a, b) => b.at.localeCompare(a.at));
      return { items: ordered.map((plan) => ({ ...plan })), nextCursor: null };
    },
    async create(input) {
      await delay();
      const id = idFactory();
      const name = input.name?.trim() || BLANK_AGENT_TITLE;
      const agent: Agent = {
        id,
        name,
        handle: input.handle ?? slugify(name),
        avatar: input.avatar ?? { shape: 'circle', color: 2, eyes: 'dot' },
        title: input.title ?? BLANK_AGENT_TITLE,
        ...(input.maxSubTasks === undefined ? {} : { maxSubTasks: input.maxSubTasks }),
        status: 'idle',
        section: input.section ?? 'Personal',
        pinned: false,
        lastActivity: 'Just created',
        unreadCount: 0,
        channels: [{ kind: 'chat', status: 'connected', detail: 'In-app chat', audience: 'You' }],
        macAccess: false,
        skillIds: [],
        pluginIds: input.pluginIds ?? [],
        sharing: { publishedToTeam: false },
        createdBy: 'member-robin',
        createdAt: iso(now()),
        updatedAt: iso(now()),
      };

      // Every agent shares the one computer (one screen).
      const shared = state.computers.find((c) => c.id === SHARED_COMPUTER_ID);
      if (shared) {
        shared.agentIds.push(agent.id);
      }

      state.agents.push(agent);
      for (const [key, file] of Object.entries(PERSONA_FILES)) {
        const text = input[key as keyof typeof PERSONA_FILES];
        if (text !== undefined && text !== '') putHomeFile(`agents/${id}/${file}`, text);
      }
      if (input.proactivePreferences) putHomeFile(`agents/${id}/AGENTS.md`, `${input.instructions ?? ''}\n\n## When to reach out\n${input.proactivePreferences}`.trim());
      emit({ type: 'agent.created', agent: { ...agent } });

      const conversation: Conversation = {
        id: idFactory(),
        kind: 'direct',
        title: agent.name,
        agentIds: [agent.id],
        memberIds: ['member-robin'],
        unreadCount: 0,
        pinned: false,
        lastItemAt: iso(now()),
        createdAt: iso(now()),
      };
      state.conversations.push(conversation);
      const greeting: Item = {
        id: idFactory(),
        conversationId: conversation.id,
        at: iso(now()),
        type: 'agent_message',
        agentId: agent.id,
        markdown: SETUP_GREETING,
        citations: [],
      };
      state.items.set(conversation.id, [greeting]);
      refreshConversation(state, conversation.id);
      emit({ type: 'item.added', conversationId: conversation.id, item: greeting });
      return { ...agent };
    },
    async update(id, patch) {
      await delay();
      // Reject obsolete per-agent model/engine keys via the contract schema
      // (z.never().optional()): defined values throw a ZodError.
      updateAgentInputSchema.parse(patch);
      const agent = agentOf(id);
      if (patch.name !== undefined) agent.name = patch.name;
      if (patch.handle !== undefined) agent.handle = patch.handle;
      if (patch.avatar !== undefined) agent.avatar = patch.avatar;
      if (patch.title !== undefined) agent.title = patch.title;
      if (patch.maxSubTasks !== undefined) agent.maxSubTasks = patch.maxSubTasks;
      if (patch.section !== undefined) agent.section = patch.section;
      if (patch.pinned !== undefined) agent.pinned = patch.pinned;
      if (patch.macAccess !== undefined) agent.macAccess = patch.macAccess;
      if (patch.pluginIds !== undefined) agent.pluginIds = patch.pluginIds;
      if (patch.channels !== undefined) agent.channels = patch.channels;
      if (patch.sharing) agent.sharing = { ...agent.sharing, ...patch.sharing };
      agent.updatedAt = iso(now());
      return { ...agent };
    },
    async pause(id) {
      await delay();
      const agent = agentOf(id);
      agent.pausedAt = iso(now());
      setAgentStatus(id, 'paused');
      return { ...agent };
    },
    async resume(id) {
      await delay();
      const agent = agentOf(id);
      delete agent.pausedAt;
      setAgentStatus(id, 'idle');
      return { ...agent };
    },
    async stop(id) {
      await delay();
      const live = state.runs.filter((run) => run.agentId === id && (run.status === 'running' || run.status === 'queued'));
      for (const run of live) await runs.stop(run.id);
      return { stopped: live.length };
    },
    async acceptRoleSuggestion(id) {
      await delay();
      const agent = agentOf(id);
      if (!agent.roleSuggestion) throw new Error(`no role suggestion: ${id}`);
      agent.title = agent.roleSuggestion.title;
      if (!agent.description) agent.description = agent.roleSuggestion.description;
      delete agent.roleSuggestion;
      return { ...agent };
    },
    async dismissRoleSuggestion(id) {
      await delay();
      const agent = agentOf(id);
      delete agent.roleSuggestion;
      agent.roleSuggestionDismissedAt ??= iso(now());
      return { ...agent };
    },
    async delete(id) {
      await delay();
      const index = state.agents.findIndex((a) => a.id === id);
      if (index < 0) throw new Error(`agent not found: ${id}`);
      state.agents.splice(index, 1);
    },
  };

  const emitComputerState = (computer: Computer): void => {
    emit({ type: 'computer.state', computerId: computer.id, state: computer.state, controller: computer.controller });
  };

  const postHandoff = (agentId: string, direction: 'to_user' | 'to_agent', durationMs?: number): void => {
    const conv = directConversationFor(agentId);
    if (!conv) return;
    postItem({ id: idFactory(), conversationId: conv.id, at: iso(now()), type: 'handoff', direction, durationMs });
  };

  /** Mock owner id for screen projections (the world's signed-in user). */
  const screenOwnerId = (): string => 'user-robin';

  const agentNameFor = (agentId: string): string | undefined =>
    state.agents.find((a) => a.id === agentId)?.name;

  /** Project a stored mock screen onto the redacted `ScreenResponse` the API returns. */
  const toScreenResponse = (
    computer: Computer,
    screen: ComputerScreen,
  ): ScreenResponse => ({
    ...screen,
    ownerId: screenOwnerId(),
    computerId: computer.id,
    controlEpoch: controlEpochs.get(screen.id) ?? 0,
    resolution: computer.resolution,
    lastUsedAt: computer.lastUpdatedAt,
  });

  /** Who holds a surface changed: bump its epoch and tell open clients (`control.changed`), like the server's control gateway. */
  const changeControl = (screen: ComputerScreen, holder: 'agent' | 'user', phase: 'taken' | 'returned'): void => {
    const epoch = (controlEpochs.get(screen.id) ?? 0) + 1;
    controlEpochs.set(screen.id, epoch);
    emit({ type: 'control.changed', ownerId: screenOwnerId(), surface: { kind: 'screen', screenId: screen.id }, agentId: screen.agentId, holder, epoch, since: iso(now()), phase });
  };

  /** Find a screen by id across the shared computer; throws like the API would. */
  const findScreen = (screenId: string): { computer: Computer; screen: ComputerScreen } => {
    for (const computer of state.computers) {
      const screen = computer.screens?.find((s) => s.id === screenId);
      if (screen) return { computer, screen };
    }
    throw new Error(`screen not found: ${screenId}`);
  };

  const computers: ApiClient['computers'] = {
    async list(params = {} as ComputersListParams) {
      await delay();
      const p = params;
      return paginate(state.computers, {
        params: p,
        predicate: (c) =>
          (p.agentId === undefined || c.agentIds.includes(p.agentId)) &&
          (p.state === undefined || c.state === p.state),
        searchText: (c) => c.name,
        defaultSort: { key: 'name', order: 'asc' },
      });
    },
    async get(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      return { ...computer };
    },
    async ensure(input) {
      await delay();
      const existing = state.computers.find((c) =>
        input?.agentId === undefined ? true : c.agentIds.includes(input.agentId),
      );
      if (existing) return { ...existing };
      // A blank world (or a newly created agent) gets the shared computer on first ensure.
      const computer = state.computers[0];
      if (!computer) throw new Error('no computer available');
      if (input?.agentId && !computer.agentIds.includes(input.agentId)) {
        computer.agentIds.push(input.agentId);
        computer.lastUpdatedAt = iso(now());
      }
      return { ...computer };
    },
    async screens(computerId) {
      await delay();
      const computer = mustFind(state.computers, computerId, 'computer');
      const items = (computer.screens ?? []).map((screen) => toScreenResponse(computer, screen));
      return { items, nextCursor: null };
    },
    async screen(computerId, agentId) {
      await delay();
      const computer = mustFind(state.computers, computerId, 'computer');
      const screen = computer.screens?.find((s) => s.agentId === agentId);
      return screen ? toScreenResponse(computer, screen) : null;
    },
    async allocateScreen(computerId, agentId) {
      await delay();
      const computer = mustFind(state.computers, computerId, 'computer');
      if (!computer.agentIds.includes(agentId)) computer.agentIds.push(agentId);
      const screens = computer.screens ?? (computer.screens = []);
      const existing = screens.find((s) => s.agentId === agentId);
      if (existing) return toScreenResponse(computer, existing);
      const screen = {
        id: `screen-${computer.id}-${agentId}`,
        agentId,
        displayNo: screens.length + 1,
        state: 'live' as const,
        controller: 'agent' as const,
        title: agentNameFor(agentId) ?? agentId,
      };
      screens.push(screen);
      computer.lastUpdatedAt = iso(now());
      emit({ type: 'computer.state', computerId: computer.id, state: computer.state, controller: computer.controller });
      return toScreenResponse(computer, screen);
    },
    async streamScreen(screenId, options) {
      await delay();
      const { screen } = findScreen(screenId);
      const base = state.settings.connections.serverUrl || 'ws://127.0.0.1:8787';
      const control = options?.control ? '1' : '0';
      const ticket = `t-${screen.id}-${control}`;
      return {
        url: `${base.replace(/^http/, 'ws')}/v1/screens/${screen.id}/vnc?t=${ticket}`,
        expiresAt: iso(now() + 5 * MINUTE),
      };
    },
    async screenshot(screenId) {
      await delay();
      const { screen } = findScreen(screenId);
      return {
        data: 'mock-screenshot',
        mimeType: 'image/png',
        width: 1364,
        height: 1024,
        displayNo: screen.displayNo,
      };
    },
    async runtime() {
      await delay();
      return { kind: 'apple-container' as const, image: { state: 'ready' as const } };
    },
    async myMac() {
      await delay();
      return { ...mac };
    },
    async pairMyMac(input) {
      await delay();
      const name = input?.name ?? 'My Mac';
      mac = { paired: true, online: true, name, pairedAt: iso(now()), user: 'you', folder: '/Users/you/Juno' };
      return { id: 'mac-mock', url: 'ws://localhost:8795/v1/computer-link', token: 'mock-token', name, pairedAt: iso(now()) };
    },
    async unpairMyMac() {
      await delay();
      mac = { paired: false, online: false };
      return { ...mac };
    },
    async stopMyMac() {
      await delay();
      if (!mac.paired) throw apiError(409, 'MAC_NOT_PAIRED', 'pair a Mac first');
      if (!mac.stopped) {
        const epoch = (controlEpochs.get('mac') ?? 0) + 1;
        controlEpochs.set('mac', epoch);
        const since = iso(now());
        mac = { ...mac, stopped: { since, epoch } };
        emit({ type: 'control.changed', ownerId: screenOwnerId(), surface: { kind: 'mac', macId: 'mac-mock' }, holder: 'stopped', epoch, since, phase: 'stopped' });
      }
      return { ...mac };
    },
    async screenElements(screenId) {
      await delay();
      const { screen } = findScreen(screenId);
      const asked = state.requests.some((r) => r.status === 'pending' && r.kind === 'computer' && r.agentId === screen.agentId);
      if (screen.controller !== 'user' && !asked) throw apiError(409, 'NOT_IN_CONTROL', 'take over the screen first');
      return { screenId, width: 1364, height: 1024, elements: [{ rect: { x: 420, y: 380, width: 320, height: 90 }, role: 'checkbox', name: 'I am not a robot' }] };
    },
    async pasteScreenClipboard(screenId, input) {
      await delay();
      const { screen } = findScreen(screenId);
      if (screen.controller !== 'user') throw apiError(409, 'NOT_IN_CONTROL', 'take over the screen first');
      if (input.kind === 'files') return { kind: 'files', saved: input.files.map((file) => ({ name: file.name, path: `Downloads/${file.name}` })) };
      return { kind: 'image', path: 'Pictures/Pasted/fixture.png' };
    },
    async copyScreenClipboard(screenId) {
      await delay();
      const { screen } = findScreen(screenId);
      if (screen.controller !== 'user') throw apiError(409, 'NOT_IN_CONTROL', 'take over the screen first');
      return { kind: 'empty' };
    },
    async takeOverScreen(screenId, options) {
      await delay();
      const { computer, screen } = findScreen(screenId);
      // A stale epoch changes nothing: the answer is the current row.
      if (options?.expectEpoch !== undefined && options.expectEpoch !== (controlEpochs.get(screen.id) ?? 0)) return toScreenResponse(computer, screen);
      screen.controller = 'user';
      screen.state = 'live';
      computer.activeAgentId = screen.agentId;
      computer.lastUpdatedAt = iso(now());
      changeControl(screen, 'user', 'taken');
      emit({ type: 'computer.state', computerId: computer.id, state: computer.state, controller: computer.controller });
      return toScreenResponse(computer, screen);
    },
    async returnControlScreen(screenId, options) {
      await delay();
      const { computer, screen } = findScreen(screenId);
      if (options?.expectEpoch !== undefined && options.expectEpoch !== (controlEpochs.get(screen.id) ?? 0)) return toScreenResponse(computer, screen);
      screen.controller = 'agent';
      computer.lastUpdatedAt = iso(now());
      changeControl(screen, 'agent', 'returned');
      emit({ type: 'computer.state', computerId: computer.id, state: computer.state, controller: computer.controller });
      return toScreenResponse(computer, screen);
    },
    async takeOver(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.controller = 'user';
      computer.lastUpdatedAt = iso(now());
      emitComputerState(computer);
      if (computer.activeAgentId) postHandoff(computer.activeAgentId, 'to_user');
      return { ...computer };
    },
    async returnControl(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.controller = 'agent';
      computer.lastUpdatedAt = iso(now());
      emitComputerState(computer);
      if (computer.activeAgentId) postHandoff(computer.activeAgentId, 'to_agent');
      return { ...computer };
    },
    async pause(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.state = 'paused';
      computer.lastUpdatedAt = iso(now());
      emitComputerState(computer);
      return { ...computer };
    },
    async resume(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.state = 'running';
      computer.lastUpdatedAt = iso(now());
      emitComputerState(computer);
      return { ...computer };
    },
    async reboot(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.state = 'rebooting';
      computer.uptimeSeconds = 0;
      computer.lastUpdatedAt = iso(now());
      emitComputerState(computer);
      setTimeout(() => {
        computer.state = 'running';
        computer.lastUpdatedAt = iso(now());
        emitComputerState(computer);
      }, Math.max(50, 1500 / speed));
      return { ...computer };
    },
    async reset(id) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.state = 'updating';
      computer.resources.disk.used = 3;
      computer.resources.memory.used = 640;
      computer.lastUpdatedAt = iso(now());
      emitComputerState(computer);
      setTimeout(() => {
        computer.state = 'running';
        computer.lastUpdatedAt = iso(now());
        emitComputerState(computer);
      }, Math.max(50, 1500 / speed));
      return { ...computer };
    },
    async setIdlePause(id, minutes) {
      await delay();
      const computer = mustFind(state.computers, id, 'computer');
      computer.idlePauseMinutes = minutes;
      computer.lastUpdatedAt = iso(now());
      return { ...computer };
    },
  };

  /** Post a user message into a conversation; unless the agent is blank, start a run. */
  const deliverMessage = (conv: Conversation, payload: ComposerPayload): { item: Item; runId: string | null } => {
    const authorId = conv.memberIds[0] ?? 'member-robin';
    const item: Item = {
      id: idFactory(),
      conversationId: conv.id,
      at: iso(now()),
      type: 'user_message',
      authorId,
      text: payload.text,
      attachments: payload.attachments ?? [],
      mentions: payload.mentions ?? [],
    };
    postItem(item);
    const agentId = conv.agentIds[0];
    if (!agentId) return { item, runId: null };

    // A blank agent replies with a setup proposal instead of starting a run.
    const agent = agentOf(agentId);
    if (isBlankAgent(agent)) {
      proposeSetup(agent, conv);
      return { item, runId: null };
    }

    const run: Run = {
      id: idFactory(),
      agentId,
      conversationId: conv.id,
      title: payload.text ? payload.text.slice(0, 72) : (payload.command?.name ?? 'New task'),
      status: 'running',
      kind: payload.options?.background ? 'background' : 'chat',
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: iso(now()),
      lastActivityAt: iso(now()),
    };
    state.runs.unshift(run);
    emitRunStarted(run);
    postItem({ id: idFactory(), conversationId: conv.id, at: iso(now()), type: 'run', runId: run.id });
    pendingReplies.push({
      runId: run.id,
      text: `Done — I’ve handled “${run.title}”.`,
      dueTick: tickIndex + 4,
    });
    setAgentStatus(agentId, 'working');
    agentOf(agentId).lastActivity = run.title;
    return { item, runId: run.id };
  };

  /** Default room title from its member agents, e.g. "Juno, Patch & Echo". */
  const roomTitleFor = (agentIds: readonly string[]): string => {
    const names = agentIds
      .map((id) => state.agents.find((a) => a.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) return 'New group';
    if (names.length === 1) return names[0]!;
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  };

  const newWireRunId = (): string => `run-wire-${idFactory()}`;

  /**
   * A standard resume segment: answer the interrupt through the same durable decision path as the
   * product request card, then continue the run. Every subscriber sees both the decision and the
   * continuation, so a decision made on one client reaches another.
   */
  const resumeSegment = async (
    conv: Conversation,
    runIdHint: string,
    entries: readonly ResumeEntry[],
  ): Promise<AguiRunResult> => {
    const firstEntry = entries[0];
    if (!firstEntry) return { runId: runIdHint || newWireRunId() };
    let request: Request | undefined;
    for (const entry of entries) {
      const found = state.requests.find((candidate) => candidate.id === entry.interruptId);
      request ??= found;
      if (!found || found.status !== 'pending') continue;
      const decision: ResolveRequestInput =
        entry.status === 'cancelled'
          ? { action: 'deny' }
          : ((entry.payload as ResolveRequestInput | undefined) ?? { action: 'approve', scope: 'once' });
      await requests.resolve(found.id, decision);
    }

    const agentId = request?.agentId ?? conv.agentIds[0];
    if (!agentId) return { runId: runIdHint || newWireRunId() };
    let run = state.runs.find((candidate) => candidate.id === (request?.runId ?? runIdHint));
    if (!run) {
      run = {
        id: runIdHint || newWireRunId(),
        agentId,
        conversationId: conv.id,
        title: request?.title ?? 'Continued run',
        status: 'running',
        kind: 'chat',
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
        startedAt: iso(now()),
        lastActivityAt: iso(now()),
      };
      state.runs.unshift(run);
      postItem({ id: idFactory(), conversationId: conv.id, at: iso(now()), type: 'run', runId: run.id });
    }
    if (run.status !== 'running') {
      run.status = 'running';
      run.lastActivityAt = iso(now());
      // Resolving the live approval already opened its continuation segment.
      if (request?.id !== LIVE_APPROVAL_ID) {
        emitRunStarted(run);
        emitRunUpdated(run);
      }
      pendingReplies.push({
        runId: run.id,
        text: firstEntry.status === 'cancelled' ? 'Understood — I stopped there.' : 'Approved — carrying on.',
        dueTick: tickIndex + 2,
      });
    }
    setAgentStatus(agentId, 'working');
    return { runId: run.id };
  };

  const conversations: ApiClient['conversations'] = {
    async list(params = {} as ConversationsListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.conversations, {
        params: p,
        predicate: (c) =>
          (p.kind === undefined || c.kind === p.kind) &&
          (p.agentId === undefined || c.agentIds.includes(p.agentId)) &&
          (p.memberId === undefined || c.memberIds.includes(p.memberId)),
        searchText: (c) => `${c.title ?? ''} ${c.agentIds.join(' ')}`,
        defaultSort: { key: 'lastItemAt', order: 'desc' },
      });
    },
    async get(id) {
      await delay();
      return { ...convOf(id) };
    },
    async create(input) {
      await delay();
      const memberAgentIds = [...new Set(input.memberAgentIds ?? [])];
      const firstAgent = memberAgentIds[0] ? state.agents.find((a) => a.id === memberAgentIds[0]) : undefined;

      // A direct thread is the agent's existing 1:1 conversation (v0.3 chat list).
      if (input.kind === 'direct' && memberAgentIds[0]) {
        const existing = directConversationFor(memberAgentIds[0]);
        if (existing) {
          if (input.firstMessage) deliverMessage(existing, input.firstMessage);
          return { ...existing };
        }
      }

      const conversation: Conversation = {
        id: idFactory(),
        kind: input.kind,
        title: input.title ?? (input.kind === 'direct' ? firstAgent?.name : roomTitleFor(memberAgentIds)),
        agentIds: memberAgentIds,
        memberIds: ['member-robin'],
        unreadCount: 0,
        pinned: false,
        lastItemAt: iso(now()),
        createdAt: iso(now()),
      };
      state.conversations.push(conversation);
      state.items.set(conversation.id, []);
      refreshConversation(state, conversation.id);
      emit({ type: 'conversation.created', conversation: { ...conversation } });
      if (input.firstMessage) deliverMessage(conversation, input.firstMessage);
      return { ...conversation };
    },
    async items(id, params = {} as ItemsListParams) {
      await delay();
      const p = params ?? {};
      const rows = state.items.get(id) ?? [];
      const filtered = p.type === undefined ? rows : rows.filter((item) => item.type === p.type);
      return paginate(filtered, {
        params: { ...p, sort: p.sort ?? 'at', order: p.order ?? 'asc' },
        searchText: (item) => JSON.stringify(item),
      });
    },
    async send(id, payload) {
      await delay();
      return deliverMessage(convOf(id), payload);
    },
    async runAgent(id, input: RunAgentInput) {
      await delay();
      const conv = convOf(id);
      if (input.resume !== undefined && input.resume.length > 0) {
        return resumeSegment(conv, input.runId, input.resume);
      }
      const forwarded = input.forwardedProps as { juno?: { composer?: ComposerPayload } } | undefined;
      const lastUser = [...input.messages].reverse().find((message) => message.role === 'user');
      const payload: ComposerPayload = forwarded?.juno?.composer ?? {
        text: typeof lastUser?.content === 'string' ? lastUser.content : '',
      };
      const result = deliverMessage(conv, payload);
      return { runId: result.runId ?? input.runId, item: result.item };
    },
    async resume(id, input: AguiResumeInput) {
      await delay();
      return resumeSegment(convOf(id), input.runId, input.resume);
    },
    async resumeRequest(id, requestId, decision, runId) {
      await delay();
      const request = mustFind(state.requests, requestId, 'request');
      const entry: ResumeEntry =
        decision.action === 'deny'
          ? { interruptId: requestId, status: 'cancelled' }
          : { interruptId: requestId, status: 'resolved', payload: decision };
      return resumeSegment(convOf(id), runId ?? request.runId ?? newWireRunId(), [entry]);
    },
    async resumeRequests(id, decisions: AguiResumeDecision[], runId) {
      await delay();
      if (decisions.length === 0) throw apiError(400, 'NO_INTERRUPTS', 'A resume batch needs at least one interrupt');
      const entries: ResumeEntry[] = decisions.map(({ requestId, decision }) =>
        decision.action === 'deny'
          ? { interruptId: requestId, status: 'cancelled' }
          : { interruptId: requestId, status: 'resolved', payload: decision },
      );
      const first = state.requests.find((candidate) => candidate.id === decisions[0]?.requestId);
      return resumeSegment(convOf(id), runId ?? first?.runId ?? newWireRunId(), entries);
    },
    async markRead(id) {
      await delay();
      const conv = convOf(id);
      conv.unreadCount = 0;
      return { ...conv };
    },
    async update(id, patch) {
      await delay();
      const conv = convOf(id);
      if (patch.pinned !== undefined) conv.pinned = patch.pinned;
      if (patch.muted !== undefined) conv.muted = patch.muted;
      emit({ type: 'conversation.updated', conversation: { ...conv } });
      return { ...conv };
    },
    async delete(id) {
      await delay();
      convOf(id);
      state.conversations.splice(state.conversations.findIndex((c) => c.id === id), 1);
      state.items.delete(id);
      emit({ type: 'conversation.deleted', conversationId: id });
    },
    async typing(id, _active) {
      await delay();
      convOf(id);
    },
  };

  const items: ApiClient['items'] = {
    async list(params = {} as ItemsListParams) {
      await delay();
      const p = params ?? {};
      const all: Item[] = [];
      for (const [conversationId, rows] of state.items) {
        if (p.conversationId && p.conversationId !== conversationId) continue;
        all.push(...rows);
      }
      const filtered = p.type === undefined ? all : all.filter((item) => item.type === p.type);
      return paginate(filtered, {
        params: { ...p, sort: p.sort ?? 'at', order: p.order ?? 'asc' },
        searchText: (item) => JSON.stringify(item),
      });
    },
    async get(id) {
      await delay();
      for (const rows of state.items.values()) {
        const found = rows.find((item) => item.id === id);
        if (found) return found;
      }
      throw new Error(`item not found: ${id}`);
    },
  };

  const runs: ApiClient['runs'] = {
    async list(params = {} as RunsListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.runs, {
        params: p,
        predicate: (r) =>
          (p.status === undefined || r.status === p.status) &&
          (p.agentId === undefined || r.agentId === p.agentId) &&
          (p.conversationId === undefined || r.conversationId === p.conversationId) &&
          (p.routineId === undefined || r.routineId === p.routineId) &&
          (p.kind === undefined || r.kind === p.kind),
        searchText: (r) => r.title,
        defaultSort: { key: 'startedAt', order: 'desc' },
      });
    },
    async get(id) {
      await delay();
      return { ...runOf(id) };
    },
    async markSeen(id) {
      await delay();
      const run = runOf(id);
      run.seenAt = iso(now());
      return { ...run };
    },
    async stop(id) {
      await delay();
      const run = runOf(id);
      // A stopped run never commits the reply it had queued: no late authoritative text.
      pendingReplies = pendingReplies.filter((reply) => reply.runId !== run.id);
      if (run.status === 'stopped') return { ...run };
      run.status = 'stopped';
      run.finishedAt = iso(now());
      run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      run.lastActivityAt = run.finishedAt;
      emitRunFinished(run, { type: 'cancelled' });
      setAgentStatus(run.agentId, 'idle');
      return { ...run };
    },
    async steps(id, params = {}) {
      await delay();
      const run = runOf(id);
      return paginate(run.steps, { params: params ?? {}, defaultSort: { key: 'index', order: 'asc' } });
    },
  };

  let vaultEntries: SecureVaultKeys["entries"] = [];
  const requests: ApiClient['requests'] = {
    async list(params = {} as RequestsListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.requests, {
        params: p,
        predicate: (r) =>
          (p.status === undefined || (p.status === 'resolved' ? r.status !== 'pending' : r.status === p.status)) &&
          (p.kind === undefined || r.kind === p.kind) &&
          (p.agentId === undefined || r.agentId === p.agentId) &&
          (p.category === undefined || (r.payload.kind === 'approval' && r.payload.brief?.categories.includes(p.category) === true)) &&
          (p.outcome === undefined || r.outcome === p.outcome),
        searchText: (r) => `${r.title} ${r.summary}`,
        // resolved history is newest decision first
        defaultSort: { key: p.status === 'resolved' ? 'resolvedAt' : 'createdAt', order: 'desc' },
      });
    },
    async get(id) {
      await delay();
      return { ...mustFind(state.requests, id, 'request') };
    },
    async resolve(id, decision) {
      await delay();
      const request = mustFind(state.requests, id, 'request');
      if (request.status !== 'pending') return { ...request };

      const status = decision.action === 'approve' ? 'approved' : decision.action === 'deny' ? 'denied' : 'answered';
      request.status = status;
      request.resolvedAt = iso(now());

      if (decision.action === 'answer' && request.payload.kind === 'question' && decision.answers) {
        request.payload.answers = { ...decision.answers };
      }
      if (decision.action === 'answer' && decision.editedDraft && request.payload.kind === 'approval' && request.payload.draft) {
        request.payload.draft = { ...request.payload.draft, body: decision.editedDraft };
      }
      request.decision = {
        by: decision.by ?? 'member-robin',
        at: iso(now()),
        mode: decision.mode ?? 'manual',
        scope: decision.scope ?? 'once',
        note: decision.note,
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      request.outcome = deriveRequestOutcome(request);
      if (decision.scope === 'delegate' && request.payload.kind === 'approval') {
        const drafts = decision.delegations ?? request.payload.delegationOffer?.suggested ?? [];
        for (const draft of drafts) createDelegation({ ...draft, agentId: request.agentId });
      }

      addAudit({
        initiator: { type: 'owner_message', conversationId: request.conversationId ?? 'conv-juno' },
        unattended: false,
        at: request.decision.at,
        actor: 'user',
        memberId: request.decision.by,
        action: request.title,
        target: 'request',
        decision: status === 'approved' ? 'approved' : status === 'denied' ? 'denied' : 'approved',
        reason: decision.note ?? `${status} by you (${request.decision.scope})`,
        requestId: request.id,
        runId: request.runId,
      });

      emit({ type: 'request.resolved', request: { ...request } });
      if (request.conversationId) refreshConversation(state, request.conversationId);

      // Resolving a setup proposal configures the blank agent (v0.3).
      if (request.id.startsWith(SETUP_REQUEST_PREFIX) && decision.action === 'answer') {
        applySetup(request, decision.answers ?? {});
      }

      if (request.id === LIVE_APPROVAL_ID) {
        const run = state.runs.find((r) => r.id === LIVE_RUN_ID);
        if (run) {
          run.status = 'running';
          run.lastActivityAt = iso(now());
          phase = 'post';
          emitRunStarted(run);
          emitRunUpdated(run);
          setAgentStatus(run.agentId, 'working');
        }
      }
      return { ...request };
    },
    async submitSecureInput(id, input) {
      await delay();
      const request = mustFind(state.requests, id, 'request');
      if (request.payload.kind !== 'secure_input') throw apiError(400, 'VALIDATION', 'not a secure input request');
      if (request.status !== 'pending') throw apiError(409, 'REQUEST_NOT_PENDING', 'request is not pending');
      const fields = request.payload.fields;
      const ids = Object.keys(input.fields);
      if (ids.length !== fields.length || !fields.every((f) => ids.includes(f.id))) {
        throw apiError(400, 'VALIDATION', 'fields must match the request fields one to one');
      }
      const screen = state.computers.flatMap((cp) => cp.screens ?? []).find((s) => s.agentId === request.agentId);
      if (screen?.controller === 'user') throw apiError(409, 'USER_CONTROL', 'hand the screen back, then try again');
      // The value goes nowhere: the mock, like the backend, never stores, logs or echoes it.
      request.payload = { ...request.payload, fields: fields.map((f) => ({ ...f, status: 'filled' as const })) };
      request.status = 'approved';
      request.resolvedAt = iso(now());
      request.decision = { by: 'member-robin', at: request.resolvedAt, mode: 'manual', scope: 'once', note: 'Filled in securely.' };
      emit({ type: 'request.resolved', request: { ...request } });
      if (request.conversationId) refreshConversation(state, request.conversationId);
      return { request: { ...request }, fields: request.payload.fields.map((f) => ({ id: f.id, status: 'filled' as const })) };
    },
    async secureVaultKeys() {
      await delay();
      return { entries: [...vaultEntries] };
    },
    async setSecureVaultKeys(input) {
      await delay();
      vaultEntries = [...input.entries];
      return { entries: [...vaultEntries] };
    },
  };

  const tasks: ApiClient['tasks'] = {
    async list(params = {}) {
      await delay();
      const live = (t: AgentTask): boolean => t.status !== 'ended';
      const items = state.tasks
        .filter((t) => (!params.agentId || t.agentId === params.agentId) && (!params.conversationId || t.conversationId === params.conversationId))
        .filter((t) => (!params.kind || t.kind === params.kind) && (!params.routineId || t.routineId === params.routineId) && (!params.rootRunId || t.rootRunId === params.rootRunId))
        .filter((t) => (params.status === 'live' ? live(t) : params.status === 'ended' ? !live(t) : true))
        .sort((a, b) => Number(live(b)) - Number(live(a)) || b.startedAt.localeCompare(a.startedAt));
      return { items: items.map((t) => ({ ...t })), nextCursor: null };
    },
    async tree(id) {
      await delay();
      const task = state.tasks.find((t) => t.id === id || t.rootRunId === id);
      if (!task) throw apiError(404, 'NOT_FOUND', `task not found: ${id}`);
      const items = state.tasks.filter((t) => t.rootRunId === task.rootRunId).sort((a, b) => a.depth - b.depth);
      return { rootRunId: task.rootRunId, origin: task.origin, items: items.map((t) => ({ ...t })), subtreeUsage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 } };
    },
    async stop(id) {
      await delay();
      const task = state.tasks.find((t) => t.id === id);
      if (!task) throw apiError(404, 'NOT_FOUND', `task not found: ${id}`);
      if (task.status === 'running' || task.status === 'waiting') {
        task.status = 'ended';
        task.outcome = 'cancelled';
        task.outcomeDetail = 'stopped_by_owner';
        task.resultLine = 'Stopped by you';
        task.progress = undefined;
        task.updatedAt = task.finishedAt = iso(now());
        emit({ type: 'task.updated', task: { ...task } });
      }
      return { ...task };
    },
  };

  const routines: ApiClient['routines'] = {
    async list(params = {} as RoutinesListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.routines, {
        params: p,
        predicate: (r) =>
          (p.agentId === undefined || r.agentId === p.agentId) &&
          (p.status === undefined || r.status === p.status) &&
          (p.enabled === undefined || r.enabled === p.enabled),
        searchText: (r) => `${r.name} ${r.instructions}`,
        defaultSort: { key: 'name', order: 'asc' },
      });
    },
    async get(id) {
      await delay();
      return { ...mustFind(state.routines, id, 'routine') };
    },
    async create(input) {
      await delay();
      const routine: Routine = {
        id: idFactory(),
        agentId: input.agentId,
        name: input.name,
        instructions: input.instructions ?? '',
        trigger: input.trigger,
        delivery: input.delivery ?? { channel: 'chat' },
        notify: input.notify ?? { mode: 'always' },
        enabled: input.enabled ?? true,
        status: input.status ?? 'active',
        nextRunAt: input.trigger.kind === 'schedule' ? iso(now() + 60 * 60 * 1000) : undefined,
        runs: [],
        createdAt: iso(now()),
      };
      state.routines.push(routine);
      emit({ type: 'routine.updated', routine: { ...routine } });
      return { ...routine };
    },
    async update(id, patch) {
      await delay();
      const routine = mustFind(state.routines, id, 'routine');
      const merged: Routine = { ...routine, ...patch } as Routine;
      if (patch.enabled !== undefined) merged.status = patch.enabled ? 'active' : 'paused';
      if (patch.trigger !== undefined) merged.trigger = patch.trigger;
      upsertById(state.routines, merged);
      emit({ type: 'routine.updated', routine: { ...merged } });
      return { ...merged };
    },
    async toggle(id, enabled) {
      await delay();
      const routine = mustFind(state.routines, id, 'routine');
      routine.enabled = enabled ?? !routine.enabled;
      routine.status = routine.enabled ? 'active' : 'paused';
      emit({ type: 'routine.updated', routine: { ...routine } });
      return { ...routine };
    },
    async rotateWebhook(id) {
      await delay();
      const routine = mustFind(state.routines, id, 'routine');
      const url = `https://hooks.test/v1/routines/${id}`;
      const secret = `whsec_${Math.random().toString(36).slice(2, 14)}`;
      routine.trigger = { kind: 'webhook', url, secretMasked: 'whsec_••••' };
      emit({ type: 'routine.updated', routine: { ...routine } });
      return { url, secret };
    },
    async delete(id) {
      await delay();
      if (!removeById(state.routines, id)) throw new Error(`routine not found: ${id}`);
    },
    async runs(id, params = {}) {
      await delay();
      const routine = mustFind(state.routines, id, 'routine');
      return paginate(routine.runs, { params: params ?? {}, defaultSort: { key: 'startedAt', order: 'desc' } });
    },
  };

  const rules: ApiClient['rules'] = {
    async list(params = {} as RulesListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.rules, {
        params: p,
        predicate: (r) =>
          (p.agentId === undefined || r.agentId === p.agentId) &&
          (p.scope === undefined || r.scope === p.scope) &&
          (p.source === undefined || r.source === p.source) &&
          (p.enabled === undefined || r.enabled === p.enabled),
        searchText: (r) => `${r.description} ${r.subject ?? ''}`,
        defaultSort: { key: 'description', order: 'asc' },
      });
    },
    async create(input) {
      await delay();
      const rule: Rule = { ...input, id: idFactory(), source: 'user', createdAt: iso(now()), createdBy: 'member-robin' };
      state.rules.push(rule);
      return { ...rule };
    },
    async update(id, patch) {
      await delay();
      const rule = mustFind(state.rules, id, 'rule');
      const merged: Rule = { ...rule, ...patch };
      upsertById(state.rules, merged);
      return { ...merged };
    },
    async delete(id) {
      await delay();
      if (!removeById(state.rules, id)) throw new Error(`rule not found: ${id}`);
    },
    async acceptDraft(id) {
      await delay();
      const rule = mustFind(state.rules, id, 'rule');
      rule.source = 'user';
      rule.enabled = true;
      rule.draftedByRunId = undefined;
      rule.rationale = undefined;
      return { ...rule };
    },
    async rejectDraft(id) {
      await delay();
      if (!removeById(state.rules, id)) throw new Error(`rule not found: ${id}`);
    },
  };

  /** A delegation is a rule with `scope: 'delegation'`; the same agent + category + platform + routine updates the limits. */
  const createDelegation = (input: CreateDelegationInput): Rule => {
    const platformKey = input.platform.kind === 'connector' ? `app:${input.platform.catalogId}` : input.platform.kind === 'site' ? `site:${input.platform.host}` : input.platform.kind === 'chat' ? `chat:${input.platform.conversationId}` : 'juno';
    // Sharing between chats lapses on its own: 90 days unless the owner picked another end.
    const expiresAt = input.expiresAt ?? (input.category === 'sharing' ? iso(now() + 90 * 86_400_000) : undefined);
    const existing = state.rules.find((r) => r.delegation?.category === input.category && r.delegation.platformKey === platformKey && r.agentId === input.agentId && r.delegation.routineId === input.routineId);
    if (existing?.delegation) {
      existing.delegation = { ...existing.delegation, limits: input.limits };
      return { ...existing };
    }
    const rule: Rule = {
      id: idFactory(), description: `${input.category} on ${input.platform.catalogId ?? input.platform.host ?? input.platform.title ?? 'Juno'}`, scope: 'delegation', behavior: 'auto', source: 'user', enabled: true,
      agentId: input.agentId, createdBy: 'member-robin', createdAt: iso(now()), useCount: 0,
      delegation: { category: input.category, platformKey, ...(input.routineId ? { routineId: input.routineId } : {}), limits: input.limits },
      ...(expiresAt ? { expiresAt } : {}),
    };
    state.rules.push(rule);
    return { ...rule };
  };
  const delegations: ApiClient['delegations'] = {
    async list(params = {}) {
      await delay();
      return paginate(state.rules, {
        params: params ?? {},
        predicate: (r) => r.scope === 'delegation' && (params?.agentId === undefined || r.agentId === params.agentId),
        defaultSort: { key: 'createdAt', order: 'desc' },
      });
    },
    async create(input) {
      await delay();
      return createDelegation(input);
    },
    async update(id, patch) {
      await delay();
      const rule = mustFind(state.rules, id, 'delegation');
      if (patch.limits && rule.delegation) rule.delegation = { ...rule.delegation, limits: patch.limits };
      if (patch.expiresAt !== undefined) rule.expiresAt = patch.expiresAt;
      if (patch.enabled !== undefined) rule.enabled = patch.enabled;
      return { ...rule };
    },
    async revoke(id) {
      await delay();
      if (!removeById(state.rules, id)) throw new Error(`delegation not found: ${id}`);
    },
  };

  const audit: ApiClient['audit'] = {
    async list(params = {} as AuditListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.audit, {
        params: p,
        predicate: (e) =>
          (p.agentId === undefined || e.agentId === p.agentId) &&
          (p.decision === undefined || e.decision === p.decision) &&
          (p.actor === undefined || e.actor === p.actor) &&
          (p.initiator === undefined || e.initiator.type === p.initiator) &&
          (p.unattended === undefined || e.unattended === p.unattended),
        searchText: (e) => `${e.action} ${e.reason}`,
        defaultSort: { key: 'at', order: 'desc' },
      });
    },
    async exportCsv(params) {
      await delay();
      const rows = state.audit.filter(
        (e) =>
          (params?.agentId === undefined || e.agentId === params.agentId) &&
          (params?.initiator === undefined || e.initiator.type === params.initiator) &&
          (params?.unattended === undefined || e.unattended === params.unattended),
      );
      const cell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
      const header = 'at,agent,action,target,decision,reason,rule,initiator,unattended,runId,requestId';
      return [header, ...rows.map((e) => [e.at, e.agentId ?? '', e.action, e.target ?? '', e.decision, e.reason, e.ruleId ?? '', e.initiator.type, String(e.unattended), e.runId ?? '', e.requestId ?? ''].map(cell).join(','))].join('\r\n') + '\r\n';
    },
  };

  const memory: ApiClient['memory'] = {
    async claims(params) {
      await delay();
      const claims = state.memoryClaims.filter((c) => params?.status === undefined || c.status === params.status);
      return structuredCloneish({ claims: [...claims].sort((x, y) => y.createdAt.localeCompare(x.createdAt)) });
    },
    async forget(input) {
      await delay();
      let retracted = 0;
      let removedLines = 0;
      for (const id of input.claimIds) {
        const claim = state.memoryClaims.find((c) => c.id === id);
        if (claim === undefined || claim.status === 'retracted') continue;
        claim.status = 'retracted';
        retracted += 1;
        for (const file of state.home) {
          const lines = file.content.split('\n');
          const kept = lines.filter((line) => !line.includes(`[claim:${id}]`));
          if (kept.length === lines.length) continue;
          removedLines += lines.length - kept.length;
          putHomeFile(file.path, kept.join('\n'), file.writer);
        }
      }
      return { retracted, removedLines };
    },
    async search(query) {
      await delay();
      const needle = query.toLowerCase();
      // Memory items, not file lines: a line carrying `[mem:<id>]` is one item; `file` is the view it is shown in.
      const fileOf = (path: string): string | undefined => {
        if (path === 'MEMORY.md') return 'memory';
        const bank = /^memory\/bank\/([a-z]+)\.md$/.exec(path);
        if (bank) return `bank:${bank[1]}`;
        return path.startsWith('people/') ? 'person' : undefined;
      };
      const hits = state.home.flatMap((f) => {
        const file = fileOf(f.path);
        if (file === undefined) return [];
        return f.content.split('\n').flatMap((line, i) => {
          if (!line.toLowerCase().includes(needle)) return [];
          const id = /\[mem:([^\]]+)\]/.exec(line)?.[1] ?? `${f.path}:${i + 1}`;
          return [{ id, text: line.replace(/\s*\[mem:[^\]]+\]/, ''), file, score: 1 }];
        });
      });
      return { hits };
    },
  };

  const goals: ApiClient['goals'] = {
    async get(id) {
      await delay();
      return { ...mustFind(state.goals, id, 'goal') };
    },
    async create(input) {
      await delay();
      const at = iso(now());
      const goal: Goal = {
        id: idFactory(),
        agentId: input.agentId,
        kind: input.kind,
        title: input.title,
        summary: input.summary ?? '',
        status: 'active',
        ...(input.category === undefined ? {} : { category: input.category }),
        activity: [{ at, actor: 'user', kind: 'created', text: input.title }],
        createdAt: at,
        updatedAt: at,
      };
      state.goals.push(goal);
      emit({ type: 'goal.updated', goal: { ...goal } });
      return { ...goal };
    },
    async list(params: GoalsListParams = {}) {
      await delay();
      const p = params ?? {};
      return paginate(state.goals, {
        params: p,
        predicate: (g) => (p.agentId === undefined || g.agentId === p.agentId) && (p.status === undefined || g.status === p.status),
        defaultSort: { key: 'updatedAt', order: 'desc' },
      });
    },
    async update(id, patch) {
      await delay();
      const goal = mustFind(state.goals, id, 'goal');
      const at = iso(now());
      const statusChanged = patch.status !== undefined && patch.status !== goal.status;
      const entry = statusChanged
        ? { at, actor: 'user' as const, kind: 'status' as const, text: 'status: ' + String(patch.status) }
        : { at, actor: 'user' as const, kind: 'updated' as const, text: Object.keys(patch).join(', ') || 'updated' };
      const merged: Goal = { ...goal, ...patch, activity: [entry, ...(goal.activity ?? [])].slice(0, 50), updatedAt: at };
      upsertById(state.goals, merged);
      emit({ type: 'goal.updated', goal: { ...merged } });
      return { ...merged };
    },
    async check(id) {
      await delay();
      const goal = mustFind(state.goals, id, 'goal');
      if (goal.status !== 'active') throw new Error('Only an active goal can be checked');
      const at = iso(now());
      const merged: Goal = { ...goal, lastCheckedAt: at, activity: [{ at, actor: 'agent' as const, kind: 'note' as const, text: 'Checked in' }, ...(goal.activity ?? [])].slice(0, 50) };
      upsertById(state.goals, merged);
      emit({ type: 'goal.updated', goal: { ...merged } });
      return { queued: true };
    },
    async delete(id) {
      await delay();
      if (!removeById(state.goals, id)) throw new Error(`goal not found: ${id}`);
      emit({ type: 'goal.deleted', goalId: id });
    },
  };

  const ideas: ApiClient['ideas'] = {
    async list(params: IdeasListParams = {}) {
      await delay();
      const p = params ?? {};
      return paginate(state.ideas, {
        params: p,
        predicate: (i) => (p.agentId === undefined || i.agentId === p.agentId) && (p.status === undefined || i.status === p.status),
        defaultSort: { key: 'updatedAt', order: 'desc' },
      });
    },
    async accept(id) {
      await delay();
      const merged: Idea = { ...mustFind(state.ideas, id, 'idea'), status: 'accepted', updatedAt: iso(now()) };
      upsertById(state.ideas, merged);
      emit({ type: 'idea.updated', idea: { ...merged } });
      return { ...merged };
    },
    async dismiss(id) {
      await delay();
      const merged: Idea = { ...mustFind(state.ideas, id, 'idea'), status: 'dismissed', updatedAt: iso(now()) };
      upsertById(state.ideas, merged);
      emit({ type: 'idea.updated', idea: { ...merged } });
      return { ...merged };
    },
  };

  // The owner's proactive rules: `less` / `never` on an idea write one; the rest only moves the idea.
  let proactiveRules: ProactiveRule[] = [];
  const proactive: ApiClient['proactive'] = {
    async feedback(input) {
      await delay();
      let idea: Idea | undefined;
      if (input.target.kind === 'idea') {
        const status = input.action === 'useful' ? 'accepted' : 'dismissed';
        idea = { ...mustFind(state.ideas, input.target.id, 'idea'), status, updatedAt: iso(now()) };
        upsertById(state.ideas, idea);
        emit({ type: 'idea.updated', idea: { ...idea } });
      }
      if (input.action !== 'less' && input.action !== 'never') return idea ? { idea } : {};
      const scope = input.scope ?? 'topic';
      const rule: ProactiveRule = {
        id: idFactory(),
        kind: input.action === 'never' ? 'dont' : 'less',
        scope,
        strength: input.action === 'never' ? 'never' : 'less',
        text: input.action === 'never' ? 'Never suggest this' : scope === 'type' ? 'Fewer ideas like this' : 'Fewer about this topic',
        source: 'Button on an idea',
        date: iso(now()).slice(0, 10),
        dueForReview: false,
      };
      proactiveRules = [...proactiveRules, rule];
      return idea ? { rule, idea } : { rule };
    },
    async listRules() {
      await delay();
      return { items: proactiveRules.map((rule) => ({ ...rule })) };
    },
    async deleteRule(id) {
      await delay();
      mustFind(proactiveRules, id, 'rule');
      proactiveRules = proactiveRules.filter((rule) => rule.id !== id);
      return {};
    },
    async keepRule(id) {
      await delay();
      const kept = { ...mustFind(proactiveRules, id, 'rule'), dueForReview: false };
      proactiveRules = proactiveRules.map((rule) => (rule.id === id ? kept : rule));
      return kept;
    },
  };

  // The agents' own calendars: a few items around now so the calendar shows something in mock/web dev.
  const seedCalendar = (): AgentCalendarItem[] => {
    const base = new Date(now());
    base.setMinutes(0, 0, 0);
    const at = (days: number, hour: number): string => {
      const d = new Date(base);
      d.setDate(d.getDate() + days);
      d.setHours(hour, 0, 0, 0);
      return iso(d.getTime());
    };
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const agentIds = state.agents.map((a) => a.id);
    const agent = (i: number): string => agentIds[i % Math.max(agentIds.length, 1)] ?? 'agent-juno';
    const stamp = iso(now());
    const common = { ownerId: 'owner-mock', timezone: zone, createdAt: stamp, updatedAt: stamp };
    return [
      { ...common, id: 'cal-follow-up', agentId: agent(0), kind: 'follow_up', title: 'Check in about the move', at: at(1, 10), instructions: 'Ask how the move went and whether anything is still needed.', withWhom: { name: 'Sam' }, status: 'scheduled' },
      { ...common, id: 'cal-meeting', agentId: agent(1), kind: 'meeting', title: 'Weekly sync', at: at(2, 15), endAt: at(2, 16), instructions: 'Join the call and take notes.', withWhom: { name: 'Design team' }, meeting: { platform: 'other', url: 'https://meet.example.com/sync' }, status: 'scheduled' },
      { ...common, id: 'cal-task', agentId: agent(2), kind: 'task', title: 'Renew the domain', at: at(4, 9), instructions: 'Renew the domain before it expires.', status: 'scheduled' },
      { ...common, id: 'cal-done', agentId: agent(0), kind: 'follow_up', title: 'Send the signed form', at: at(-2, 11), instructions: 'Send the signed form back.', status: 'done', result: 'Sent and confirmed.' },
    ];
  };
  let calendarItems: AgentCalendarItem[] = seedCalendar();

  const calendar: ApiClient['calendar'] = {
    async list(params = {}) {
      await delay();
      const from = params.from ? Date.parse(params.from) : -Infinity;
      const to = params.to ? Date.parse(params.to) : Infinity;
      const items = calendarItems
        .filter((c) => (params.agentId === undefined || c.agentId === params.agentId) && Date.parse(c.at) >= from && Date.parse(c.at) < to)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return { items: items.map((c) => ({ ...c })) };
    },
    async update(id, input) {
      await delay();
      const merged: AgentCalendarItem = { ...mustFind(calendarItems, id, 'calendar item'), ...input, updatedAt: iso(now()) };
      upsertById(calendarItems, merged);
      return { ...merged };
    },
    async cancel(id) {
      await delay();
      const merged: AgentCalendarItem = { ...mustFind(calendarItems, id, 'calendar item'), status: 'cancelled', updatedAt: iso(now()) };
      upsertById(calendarItems, merged);
      return { ...merged };
    },
  };

  const dismissedInspiration = new Set<string>();
  const STARTERS: Inspiration[] = [
    { id: 'cap-news', source: 'capability', title: 'Get a daily news brief', prompt: 'Brief me on the news each morning.', reason: 'Appears in your Feed at 8:00', action: { type: 'chat', text: 'Set up a routine that briefs me on the news each morning.' } },
    { id: 'cap-plan', source: 'profile', title: 'Plan your week', prompt: 'Help me plan my week.', reason: 'A good first chat', action: { type: 'chat', text: 'Help me plan my week.' } },
  ];

  const feed: ApiClient['feed'] = {
    async list(params: FeedListParams = {}) {
      await delay();
      const p = params ?? {};
      return paginate(state.feedPosts, {
        params: p,
        predicate: (post) => p.agentId === undefined || post.agentId === p.agentId,
        defaultSort: { key: 'createdAt', order: 'desc' },
      });
    },
    async like(id, liked) {
      await delay();
      const merged: FeedPost = { ...mustFind(state.feedPosts, id, 'feed post'), liked, updatedAt: iso(now()) };
      upsertById(state.feedPosts, merged);
      emit({ type: 'feed.updated', post: { ...merged } });
      return { ...merged };
    },
    async feedback(id, input) {
      await delay();
      const merged: FeedPost = {
        ...mustFind(state.feedPosts, id, 'feed post'),
        feedback: input.signal,
        ...(input.reason ? { feedbackReason: input.reason } : {}),
        ...(input.note ? { feedbackNote: input.note } : {}),
        updatedAt: iso(now()),
      };
      upsertById(state.feedPosts, merged);
      emit({ type: 'feed.updated', post: { ...merged } });
      return { ...merged };
    },
    async today() {
      await delay();
      const at = new Date(now());
      const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
      const pending = state.requests.filter((request) => request.status === 'pending');
      const posts = state.feedPosts
        .filter((post) => Date.parse(post.createdAt) >= midnight)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const newest = posts[0];
      return {
        now: { hour: at.getHours(), localDate: iso(at.getTime()).slice(0, 10), timezone: 'UTC' },
        needsYou: {
          count: pending.length,
          top: pending.slice(0, 2).map((request) => ({ requestId: request.id, agentId: request.agentId, title: request.title })),
          total: pending.length,
          items: pending.slice(0, 10).map((request) => ({ kind: 'request' as const, requestId: request.id, agentId: request.agentId, title: request.title })),
        },
        working: state.runs
          .filter((run) => !run.parentRunId && run.status === 'running')
          .map((run) => ({ agentId: run.agentId, runId: run.id, title: run.title })),
        progress: {
          runsToday: state.runs.filter((run) => !run.parentRunId && Date.parse(run.startedAt) >= midnight).length,
          working: state.runs
            .filter((run) => !run.parentRunId && run.status === 'running')
            .map((run) => ({ agentId: run.agentId, runId: run.id, title: run.title })),
          goals: state.goals
            .filter((goal) => goal.status === 'active')
            .slice(0, 5)
            .map((goal) => ({
              goalId: goal.id,
              agentId: goal.agentId,
              title: goal.title,
              done: goal.steps?.filter((step) => step.done).length ?? 0,
              total: goal.steps?.length ?? 0,
            })),
        },
        feed: posts.slice(0, 5).map((post) => ({
          id: post.id,
          agentId: post.agentId,
          title: post.title,
          summary: post.summary,
          ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
          createdAt: post.createdAt,
          liked: post.liked,
        })),
        ideas: state.ideas.filter((idea) => idea.status === 'open').slice(0, 3),
        ...(newest
          ? { brief: { routineId: newest.routineId ?? newest.agentId, postIds: posts.map((post) => post.id), summary: posts.length > 1 ? `${newest.title} · ${posts.length - 1} more` : newest.title, at: newest.createdAt } }
          : {}),
        userState: 'regular' as const,
        completed: state.runs
          .filter((run) => !run.parentRunId && run.status === 'completed' && !run.seenAt && run.finishedAt)
          .slice(0, 3)
          .map((run) => ({ runId: run.id, agentId: run.agentId, title: run.title, finishedAt: run.finishedAt as string })),
        inspiration: STARTERS.filter((card) => !dismissedInspiration.has(card.id)),
      };
    },
  };

  const inspiration: ApiClient['inspiration'] = {
    async dismiss(id) {
      await delay();
      dismissedInspiration.add(id);
    },
  };

  // Version history per skill, newest first. The skill's `active` is the version the agent loads; a version's text never changes.
  const skillVersions = new Map<string, SkillVersion[]>();
  const historyOf = (skill: Skill): SkillVersion[] => {
    if (!skillVersions.has(skill.id)) skillVersions.set(skill.id, skill.active ? [skill.active] : []);
    return skillVersions.get(skill.id) ?? [];
  };
  const newVersion = (skillId: string, input: UpdateSkillInput, version: number): SkillVersion => ({
    id: idFactory(),
    skillId,
    version,
    status: 'active',
    name: input.name,
    description: input.description ?? '',
    instructions: input.instructions,
    deps: (input.deps ?? []).map((dep) => (dep.type === 'tool' ? { type: 'tool', name: dep.name, schemaHash: null } : { ...dep })),
    origin: 'manual',
    used: 0,
    helpful: 0,
    harmful: 0,
    lastUsedAt: null,
    createdAt: iso(now()),
  });
  /** Moves the active pointer: the previous active version is retired, the target becomes active. */
  const point = (skill: Skill, target: SkillVersion): Skill => {
    for (const version of historyOf(skill)) if (version.status === 'active') version.status = 'retired';
    target.status = 'active';
    skill.active = { ...target };
    return { ...skill, active: { ...target } };
  };

  const skills: ApiClient['skills'] = {
    async list(params = {} as SkillsListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.skills, {
        params: p,
        predicate: (s) => (p.scope === undefined || s.scope === p.scope) && (p.agentId === undefined || s.agentId === p.agentId),
        searchText: (s) => `${s.active?.name ?? ''} ${s.active?.description ?? ''}`,
        defaultSort: { key: 'active.used', order: 'desc' },
      });
    },
    async get(id) {
      await delay();
      return { ...mustFind(state.skills, id, 'skill') };
    },
    async create(input) {
      await delay();
      const id = idFactory();
      const active = newVersion(id, input, 1);
      const skill: Skill = { id, scope: input.agentId ? 'agent' : 'owner', agentId: input.agentId ?? null, active, createdAt: active.createdAt };
      state.skills.push(skill);
      skillVersions.set(id, [active]);
      return { ...skill, active: { ...active } };
    },
    async update(id, input) {
      await delay();
      const skill = mustFind(state.skills, id, 'skill');
      const history = historyOf(skill);
      const next = newVersion(skill.id, input, Math.max(0, ...history.map((version) => version.version)) + 1);
      history.unshift(next);
      return point(skill, next);
    },
    async versions(id) {
      await delay();
      return historyOf(mustFind(state.skills, id, 'skill')).map((version) => ({ ...version }));
    },
    async activate(id, version) {
      await delay();
      const skill = mustFind(state.skills, id, 'skill');
      const target = historyOf(skill).find((candidate) => candidate.version === version);
      if (!target) throw apiError(404, 'SKILL_VERSION_NOT_FOUND', `No version ${version} of this skill.`);
      return point(skill, target);
    },
    async rollback(id) {
      await delay();
      const skill = mustFind(state.skills, id, 'skill');
      const current = skill.active?.version ?? 0;
      const previous = historyOf(skill)
        .filter((version) => version.status === 'retired' && version.version < current)
        .sort((a, b) => b.version - a.version)[0];
      if (!previous) throw apiError(409, 'SKILL_NO_PREVIOUS_VERSION', 'There is no earlier version to roll back to.');
      return point(skill, previous);
    },
  };

  const plugins: ApiClient['plugins'] = {
    async list(params = {} as PluginsListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.plugins, {
        params: p,
        predicate: (pl) => (p.category === undefined || pl.category === p.category) && (p.installed === undefined || pl.installed === p.installed),
        searchText: (pl) => `${pl.name} ${pl.publisher} ${pl.description}`,
        defaultSort: { key: 'name', order: 'asc' },
      });
    },
    async get(id) {
      await delay();
      return { ...mustFind(state.plugins, id, 'plugin') };
    },
    async install(id) {
      await delay();
      const plugin = mustFind(state.plugins, id, 'plugin');
      plugin.installed = true;
      plugin.accounts = [
        { id: `acct-${plugin.id}`, label: `${plugin.name} · acme`, status: 'connected', connectedAt: iso(now()) },
      ];
      return { ...plugin };
    },
    async uninstall(id) {
      await delay();
      const plugin = mustFind(state.plugins, id, 'plugin');
      plugin.installed = false;
      plugin.accounts = [];
      plugin.usedByAgentIds = [];
      return { ...plugin };
    },
    async setToolPermission(input) {
      await delay();
      const plugin = mustFind(state.plugins, input.pluginId, 'plugin');
      const target = plugin.tools.find((t) => t.id === input.toolId || t.name === input.toolId);
      if (!target) throw new Error(`tool not found: ${input.toolId}`);
      target.permission = input.permission as ToolPermission;
      return { ...plugin };
    },
    async secrets() {
      await delay();
      return state.secrets.map((s) => ({ ...s }));
    },
  };

  // Apps: the Apps page's catalog (chat, work, web) with what the owner added and which agents may use each.
  const apps: ApiClient['apps'] = createAppsMock({ delay, newId: () => idFactory(), now, agentIds: () => state.agents.map((agent) => agent.id) });

  const meals: ApiClient['meals'] = {
    async list() {
      await delay();
      return { items: [], nextCursor: null };
    },
  };

  const library: ApiClient['library'] = {
    async list(params = {} as LibraryListParams) {
      await delay();
      const p = params ?? {};
      return paginate(state.library, {
        params: p,
        predicate: (a) =>
          (p.kind === undefined || a.kind === p.kind) &&
          (p.agentId === undefined || a.createdByAgentId === p.agentId) &&
          (p.conversationId === undefined || a.conversationId === p.conversationId) &&
          (p.shared === undefined || a.shared === p.shared) &&
          (p.source === undefined || a.source === p.source),
        searchText: (a) => `${a.name} ${a.tags.join(' ')}`,
        defaultSort: { key: 'updatedAt', order: 'desc' },
      });
    },
    async get(id) {
      await delay();
      return { ...mustFind(state.library, id, 'library item') };
    },
    async setPinned(id, pinned) {
      await delay();
      const item = mustFind(state.library, id, 'library item');
      item.pinned = pinned;
      item.updatedAt = iso(now());
      return { ...item };
    },
    async delete(id) {
      await delay();
      if (!removeById(state.library, id)) throw new Error(`library item not found: ${id}`);
    },
    async download(id): Promise<FileDownload> {
      await delay();
      const item = mustFind(state.library, id, 'library item');
      return {
        name: item.name,
        mimeType: item.mimeType,
        contentBase64: btoa(
          item.mimeType === 'image/svg+xml'
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#e9e9e9"/><rect x="40" y="40" width="560" height="60" rx="12" fill="#cfcfcf"/><rect x="40" y="130" width="360" height="230" rx="16" fill="#dcdcdc"/></svg>'
            : `fixture-bytes:${item.id}:${item.name}`,
        ),
      };
    },
    async upload(input) {
      await delay();
      const at = iso(now());
      const kind = input.mimeType.startsWith('image/') ? 'image' : 'file';
      const sizeBytes = atob(input.contentBase64).length;
      const mimeType = input.mimeType === '' ? 'application/octet-stream' : input.mimeType;
      const item: LibraryItem = { id: idFactory(), name: input.name, kind, mimeType, sizeBytes, shared: 'private', source: 'upload', tags: [], pinned: false, createdAt: at, updatedAt: at };
      state.library.unshift(item);
      return { id: item.id, name: item.name, kind, mimeType, sizeBytes };
    },
  };

  const artifacts: ApiClient['artifacts'] = {
    async get(id) {
      await delay();
      const { pinned: _pinned, folder: _folder, ...artifact } = mustFind(state.library, id, 'artifact');
      if (!artifact.render) throw new Error(`artifact not found: ${id}`);
      return artifact;
    },
    async version(id, version) {
      await delay();
      const found = mustFind(state.library, id, 'artifact').versions?.find((v) => v.version === version);
      if (!found) throw new Error(`artifact version not found: ${id}@${version}`);
      return { ...found };
    },
    async download(id, version, part = 'file') {
      await delay();
      return mockArtifactDownload(mustFind(state.library, id, 'artifact'), version, part);
    },
    async renderUrl(id, version) {
      await delay();
      const artifact = mustFind(state.library, id, 'artifact');
      if (artifact.render !== 'html') throw new Error('NOT_HTML');
      return mockRenderUrl(version);
    },
  };

  const documents = createDocumentsMock({
    library: () => state.library,
    delay,
    newId: () => idFactory(),
    now: () => new Date(now()),
    openConversation: (agentId) => conversations.create({ kind: 'direct', memberAgentIds: [agentId] }),
  });

  const spaces: ApiClient['spaces'] = {
    async list() {
      await delay();
      return { items: state.spaces.map((space) => ({ ...space })) };
    },
    async get(id) {
      await delay();
      return { ...mustFind(state.spaces, id, 'space') };
    },
    async openUrl(id) {
      await delay();
      const space = mustFind(state.spaces, id, 'space');
      // Opening wakes a paused computer (the real proxy does it on the first request).
      space.status = 'running';
      return { url: `https://${space.id}.spaces.example.test/__juno/auth?token=mock-${Date.now()}`, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    },
    async publishHosted(id, body) {
      await delay();
      const space = mustFind(state.spaces, id, 'space');
      const prior = space.hosted;
      const now = new Date().toISOString();
      // A republish keeps the link (same URL, next version) and the access unless one is given.
      space.hosted = {
        spaceId: space.id,
        url: prior?.url ?? `https://${space.id}-mock.spaces.example.test/`,
        visibility: body?.visibility ?? prior?.visibility ?? 'link',
        visitorWrites: body?.visitorWrites ?? prior?.visitorWrites ?? false,
        version: (prior?.version ?? 0) + 1,
        publishedAt: prior?.publishedAt ?? now,
        updatedAt: now,
      };
      return { ...space.hosted };
    },
    async updateHosted(id, body) {
      await delay();
      const space = mustFind(state.spaces, id, 'space');
      if (!space.hosted) throw new Error('NOT_HOSTED');
      space.hosted = { ...space.hosted, ...body, updatedAt: new Date().toISOString() };
      return { ...space.hosted };
    },
    async revokeHosted(id) {
      await delay();
      const space = mustFind(state.spaces, id, 'space');
      delete space.hosted;
    },
    async hostedOpenUrl(id) {
      await delay();
      const space = mustFind(state.spaces, id, 'space');
      if (!space.hosted) throw new Error('NOT_HOSTED');
      return { url: `${space.hosted.url}__auth?t=mock-${Date.now()}`, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    },
  };

  const usage: ApiClient['usage'] = {
    async get() {
      await delay();
      return {
        week: { ...state.usage.week },
        byAgent: state.usage.byAgent.map((a) => ({ ...a })),
        byApp: state.usage.byApp.map((a) => ({ ...a })),
      };
    },
    async ledger(params) {
      await delay();
      const runs = state.runs
        .filter((run) => params?.agentId === undefined || run.agentId === params.agentId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return {
        items: runs.map((run) => ({
          runId: run.id,
          agentId: run.agentId,
          ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
          ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
          ...(run.model === undefined ? {} : { model: run.model }),
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          costUsd: run.usage.costUsd,
          ...(run.usage.costKnown === undefined ? {} : { costKnown: run.usage.costKnown }),
          ...(run.usage.measured === undefined ? {} : { measured: run.usage.measured }),
          startedAt: run.startedAt,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        })),
        nextCursor: null,
        byModel: [...new Set(runs.map((run) => run.model ?? 'unknown'))].map((model) => {
          const group = runs.filter((run) => (run.model ?? 'unknown') === model);
          return {
            model,
            runs: group.length,
            inputTokens: group.reduce((sum, run) => sum + run.usage.inputTokens, 0),
            outputTokens: group.reduce((sum, run) => sum + run.usage.outputTokens, 0),
            costUsd: group.reduce((sum, run) => sum + run.usage.costUsd, 0),
          };
        }),
      };
    },
  };

  const modelCatalog: ModelCatalog = {
    defaultModel: 'mock-main',
    items: [
      { id: 'mock-main', name: 'Mock Main', supportsImages: true, reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'mock-fast', name: 'Mock Fast', supportsImages: false, reasoningEfforts: [] },
    ],
  };

  const home: ApiClient['home'] = {
    async list(prefix = '') {
      await delay();
      return { files: structuredCloneish(state.home.filter((f) => f.path.startsWith(prefix))) };
    },
    async write(path, input) {
      await delay();
      const current = state.home.find((f) => f.path === path);
      if (input.expectedHash !== undefined && current !== undefined && current.hash !== input.expectedHash) {
        throw apiError(409, 'HOME_CONFLICT', `${path} changed since you loaded it; reload and retry`);
      }
      return structuredCloneish(putHomeFile(path, input.content));
    },
    async delete(path) {
      await delay();
      state.home = state.home.filter((f) => f.path !== path);
      emit({ type: 'agent.home.changed', path });
    },
  };

  /** The fast and System One models background calls would use now (backend BACKEND.md §10.14 rules). */
  function withEffective(): AppSettingsResponse {
    const { models, ...rest } = state.settings;
    const own = state.modelProviders;
    const cheap = own.providers.flatMap((row) => {
      const hit = row.kind === 'systemone' || !row.hasKey ? undefined : providerCatalog(own, row.id)?.items.find((item) => item.cheap);
      return hit ? [{ providerId: row.id as string | null, modelId: hit.id }] : [];
    })[0];
    const agent = models?.defaultModel ? { providerId: models.providerId ?? null, modelId: models.defaultModel } : null;
    const platform = own.platformDefault ? { providerId: null, modelId: modelCatalog.defaultModel } : null;
    const tierDefault = (name: TierName) => (name === 'fast' ? (own.platformDefault ? { providerId: null, modelId: 'mock-fast' } : (cheap ?? agent)) : (agent ?? platform));
    const effectiveTier = (name: TierName): EffectiveTier | null => {
      const row = models?.tiers?.[name];
      const model = row?.modelId ? { providerId: row.providerId ?? null, modelId: row.modelId } : tierDefault(name);
      if (!model) return null;
      return { ...model, effort: row?.effort ?? null, source: row?.modelId || row?.effort ? 'chosen' : 'default' };
    };
    const effectiveTiers: EffectiveTiers = { chat: effectiveTier('chat'), task: effectiveTier('task'), deep: effectiveTier('deep'), fast: effectiveTier('fast') };
    const chosenOne = models?.systemOneModel ?? null;
    const effectiveSystemOneModel: EffectiveSystemOneModel | null = chosenOne
      ? { ...chosenOne, source: 'chosen' }
      : own.platformDefault
        ? { providerId: null, modelId: 'jev-latest', source: 'platform' }
        : effectiveTiers.fast
          ? { providerId: effectiveTiers.fast.providerId, modelId: effectiveTiers.fast.modelId, source: 'fast-model-emulation' }
          : null;
    return structuredCloneish({ ...rest, ...(models ? { models } : {}), effectiveTiers, effectiveSystemOneModel });
  }

  /** Each tier row must name one of the owner's providers (or none: the platform default), a model it lists, and a level that model offers. */
  function checkTiers(tiers: Tiers | null | undefined) {
    for (const name of ['chat', 'task', 'deep', 'fast'] as const) {
      const row = tiers?.[name];
      if (!row) continue;
      if (name === 'fast' && row.effort !== undefined && row.modelId === undefined) throw apiError(400, 'INVALID_INPUT', 'fast effort needs a fast modelId');
      let catalog: ModelCatalog | null = null;
      if (row.providerId !== undefined) {
        const provider = state.modelProviders.providers.find((entry) => entry.id === row.providerId);
        if (!provider || provider.kind === 'systemone') throw apiError(400, 'UNKNOWN_PROVIDER', 'Unknown model provider');
        catalog = providerCatalog(state.modelProviders, provider.id);
      } else if (row.modelId !== undefined) {
        catalog = modelCatalog;
      }
      const item = row.modelId === undefined ? undefined : catalog?.items.find((entry) => entry.id === row.modelId);
      if (row.modelId !== undefined && !item) throw apiError(400, 'UNKNOWN_MODEL', 'Unknown model');
      if (row.effort !== undefined && item && !(item.reasoningEfforts ?? []).includes(row.effort)) {
        throw apiError(400, 'UNSUPPORTED_EFFORT', 'Unsupported effort');
      }
    }
  }

  /** A System One pick must name one of the owner's System One providers and a model it lists. */
  function checkChoice(choice: { providerId: string; modelId: string } | null | undefined, systemOne: boolean) {
    if (!choice) return;
    const provider = state.modelProviders.providers.find((row) => row.id === choice.providerId);
    if (!provider || (provider.kind === 'systemone') !== systemOne) throw apiError(400, 'UNKNOWN_PROVIDER', 'Unknown model provider');
    if (!providerCatalog(state.modelProviders, provider.id)?.items.some((item) => item.id === choice.modelId)) {
      throw apiError(400, 'UNKNOWN_MODEL', 'Unknown model');
    }
  }

  let profile: Profile = { entries: [] };
  const profileApi: ApiClient['profile'] = {
    async get() {
      await delay();
      return structuredCloneish(profile);
    },
    async put(input) {
      await delay();
      const parsed = putProfileInputSchema.safeParse(input);
      if (!parsed.success) throw apiError(400, 'INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid profile');
      const at = new Date(now()).toISOString();
      const before = new Map(profile.entries.map((entry) => [entry.id, entry]));
      profile = {
        entries: parsed.data.entries.map((entry) => {
          const old = before.get(entry.id);
          return { ...entry, source: old !== undefined && old.key === entry.key && old.value === entry.value ? old.source : { by: 'user' as const, at } };
        }),
        updatedAt: at,
      };
      return structuredCloneish(profile);
    },
  };

  const settings: ApiClient['settings'] = {
    async get() {
      await delay();
      return withEffective();
    },
    async models() {
      await delay();
      return structuredCloneish(modelCatalog);
    },
    async update(patch) {
      await delay();
      const providerId = patch.models?.providerId;
      if (typeof providerId === 'string' && !providerCatalog(state.modelProviders, providerId)) {
        throw apiError(400, 'UNKNOWN_PROVIDER', 'Unknown model provider');
      }
      checkTiers(patch.models?.tiers);
      checkChoice(patch.models?.systemOneModel, true);
      state.settings = {
        ...state.settings,
        ...patch,
        general: { ...state.settings.general, ...patch.general },
        appearance: { ...state.settings.appearance, ...patch.appearance },
        yourComputer: { ...state.settings.yourComputer, ...patch.yourComputer },
        connections: { ...state.settings.connections, ...patch.connections },
        privacy: { ...state.settings.privacy, ...patch.privacy },
        advanced: { ...state.settings.advanced, ...patch.advanced },
        models: {
          ...state.settings.models,
          ...patch.models,
          defaultModel:
            patch.models?.defaultModel !== undefined
              ? patch.models.defaultModel
              : (state.settings.models?.defaultModel ?? null),
        },
      };
      return withEffective();
    },
  };

  // Local deep-ish clone that avoids structuredClone (not in ES2023 lib).
  function structuredCloneish<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  const api: ApiClient = {
    inspiration,
    transcribe: () => Promise.reject(Object.assign(new Error('Dictation is not available in the demo'), { status: 503 })),
    macApps: () => Promise.resolve({ apps: [] }),
    revokeMacApp: () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 })),
    // People and memory items (contract 0.60.0): the demo world has none, so the lists are empty.
    people: {
      list: async () => ({ items: [], nextCursor: null }),
      possibleMatches: async () => ({ items: [], nextCursor: null }),
      link: async () => undefined,
      unlinkAccount: async () => undefined,
      rename: async () => undefined,
      confirmRelation: async (id) => ({ id, confirmed: true as const }),
      deleteRelation: async () => undefined,
    },
    memoryItems: {
      list: async () => ({ items: [], nextCursor: null }),
      topics: async () => ({ items: [] }),
      review: async () => ({ items: [] }),
      update: async () => undefined,
      delete: async () => undefined,
      resolveReview: async () => undefined,
    },
    // The demo world is the only place a fabricated desktop is drawn; a live client omits this.
    mode: 'mock',
    home,
    agents,
    computers,
    conversations,
    items,
    runs,
    requests,
    tasks,
    routines,
    rules,
    delegations,
    audit,
    memory,
    goals,
    ideas,
    proactive,
    calendar,
    feed,
    skills,
    plugins,
    apps,
    meals,
    library,
    artifacts,
    documents,
    spaces,
    usage,
    settings,
    profile: profileApi,
    modelProviders: createModelProvidersMock({ state: () => state.modelProviders, delay, newId: () => idFactory(), now }),
  };

  const client: MockClient = {
    ...api,
    subscribe(handler: EventHandler): Unsubscribe {
      const unsubscribe = bus.subscribe(handler);
      ensureTimer();
      return () => {
        unsubscribe();
        if (bus.size() === 0) stopTimer();
      };
    },
    subscribeReset(listener) {
      return bus.subscribeReset(listener);
    },
    cursor() {
      return bus.cursor();
    },
    replaySince(cursor) {
      return bus.replaySince(cursor);
    },
    snapshot(conversationId) {
      return snapshotOf(conversationId);
    },
    reconnect(conversationId) {
      emit(snapshotOf(conversationId));
    },
    reset() {
      stopTimer();
      state = withSeedIdeas(buildWorld(clock(), seed));
      proactiveRules = [];
      profile = { entries: [] };
      calendarItems = seedCalendar();
      mac = { paired: false, online: false };
      controlEpochs.clear();
      rng = createRng(seed);
      idFactory = createIdFactory('gen', rng);
      resetSim();
      pendingReplies = [];
      // The server cannot replay from the client's old cursor: start a fresh window and tell it.
      bus.resetReplay();
      ensureTimer();
    },
    pause() {
      paused = true;
      stopTimer();
    },
    resume() {
      paused = false;
      ensureTimer();
    },
    isPaused() {
      return paused;
    },
    now() {
      return now();
    },
    setSpeed(next) {
      speed = next;
      if (timer !== null) {
        stopTimer();
        ensureTimer();
      }
    },
    advance(times = 1) {
      for (let i = 0; i < times; i += 1) runTick();
    },
    setMyMacOnline(online) {
      if (mac.paired) mac = { ...mac, online };
    },
    resumeMyMac() {
      if (!mac.stopped) return;
      const epoch = (controlEpochs.get('mac') ?? 0) + 1;
      controlEpochs.set('mac', epoch);
      const { stopped: _stopped, ...running } = mac;
      mac = running;
      emit({ type: 'control.changed', ownerId: screenOwnerId(), surface: { kind: 'mac', macId: 'mac-mock' }, holder: 'agent', epoch, since: iso(now()), phase: 'resumed' });
    },
  };

  return client;
}
