import { z } from 'zod';
import { calendarLine } from '../../modules/calendar/index.js';
import type { BrainContext, Compaction, Store, TranscriptEntry, WakeEvent } from '../../contracts/index.js';
import { buildGoalSection } from '../../modules/goals/index.js';
import type { MemorySection } from '../../modules/memory/section.js';
import { presenceOf } from '../../modules/memory/presence.js';
import { readToolScope, resolveToolScope, scopeOfPresence, type ToolScope } from '../../modules/tools/scope.js';
import type { MemoryPort } from '../../modules/memory/port.js';
import type { ConnectorCatalog } from '../../modules/mcp/catalog.js';
import { peoplePageList } from '../../modules/people/pages.js';
import { childRunIdOfSession, docOwner } from '../execution-owner.js';
import { currentOwnerId } from '../../owner-context.js';
import { loadHomeView, type HomeDeps } from '../../modules/home/service.js';
import { EMPTY_HOME_VIEW, homeViewSchema, type HomeView } from '../../modules/home/render.js';
import type { Message } from '@earendil-works/pi-ai';
import { isLocale, isTimeZone, type PermissionTiers } from '@agent-desktop/public-contracts';
import { parseMessage, pruneOldScreenshots, withoutUserImages } from './messages.js';
import { appendToTranscript, readTranscript } from './transcript.js';
import { presenceLine } from '../presence.js';
import { buildPhoneSection } from '../phone.js';
import { buildMessages, estimateMessagesTokens, readCompaction, readLatestCompaction } from './compaction.js';
import {
  deliveredHashes, deliveredItemIds, diffSections, findSystemEntry, hasPendingToolCall, hashText, isSystemEntry, metaOf, noteMessage, renderNote,
  rulesUpdatedNote, systemMessage, type SectionTexts,
} from './context-notes.js';
import { withHarnessVersion, type HarnessVersion } from '../../modules/harness/loader.js';
import { sessionHarnessVersion } from '../../modules/harness/pin.js';
import type { HarnessPins } from '../../modules/harness/store.js';
import { buildWhereSection } from './where-you-are.js';
import { buildGroupNoteSection } from './group-note.js';
import { mergeToolOrder } from './tool-order.js';
import type { ToolSearchMode } from './tool-search-mode.js';
import { knownLimits, type LimitsAwareProvider, type ModelLimits } from './model-limits.js';
import { buildSocialContext, buildTeamSection, currentIdentityLines, meaningfulRole, quoteLabel } from './social-context.js';
import { wakeSummary } from './social-roster.js';
import type { EffortLane } from './reasoning-tier.js';
import { parseModelSnapshot, settingsIdFor, type ModelSelection, type ModelSnapshot } from './model-selection.js';
import { buildRoomHistory } from './room-history.js';
import { buildTaskSection } from './task-context.js';
import { buildArtifactsSection } from './artifacts-context.js';
import type { PlatformSkillsService } from '@agent-desktop/memory-graph/skills';
import { buildSkillsSection } from './resources/skills.js';
import { safeGet } from './social-read.js';
import { profileAudience, profileSection, readProfile, type ProfileAudience } from '../../modules/profile/index.js';
import { readVaultEntries, vaultSection } from '../../modules/secure-vault/index.js';
import { buildComputerFacts, buildComputerRules, type ComputerEnvironmentSource, type RunComputerEnvironment } from './resources/computer-environment.js';
import { harnessText } from '../../modules/harness/loader.js';
import type { HarnessId } from '../../modules/harness/ids/index.js';

export type { ComputerEnvironmentSource, RunComputerEnvironment };

export { buildSocialContext } from './social-context.js';

export interface BrainContextData extends BrainContext {
  /** Absent on a slim (journaled) context: `hydrateContext` rebuilds it from the transcript. */
  messages: Message[];
  systemPrompt: string;
  compactionEpoch: number;
  /** Highest non-system transcript seq this context was built from; a rebuild from the reference reads no further. */
  uptoSeq?: number;
  /** Epoch of the compaction checkpoint the projection used, -1 for none. */
  checkpointEpoch?: number;
  /** Estimated tokens of `messages` at build time, so the compaction check needs no message list. */
  contextTokens?: number;
  /** The session's tool order, merged with every tool name seen so far (see tool-order.ts). */
  toolOrder?: string[];
  /** Who was present when the conversation started: the tools offered to it (modules/tools/scope.ts), frozen with the system row. */
  toolScope?: ToolScope;
  /** Frozen account model choice journaled at the first build; absent on legacy contexts. */
  modelSelection?: ModelSnapshot;
  /** Authoritative limits reported by the provider for this context build, when available. */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** The agent's home files as of the last snapshot (BACKEND §5.3): reused until a file-changing tool runs. */
  home?: HomeView;
  /** The harness version this context was built from (BACKEND §11.2); recorded on the run for result statistics. */
  harnessVersion?: string;
}

const contextMetadataSchema = z.object({
  sessionKey: z.string(),
  agentId: z.string(),
  systemPrompt: z.string(),
  compactionEpoch: z.number(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
});

export function parseContext(ctx: BrainContext): BrainContextData {
  const metadata = contextMetadataSchema.parse(ctx);
  // Validate the journaled snapshot before anything trusts it: a present but malformed
  // snapshot throws ModelSelectionError (terminal downstream), while only a missing
  // snapshot falls back to the legacy bootstrap provider.
  const snapshot = parseModelSnapshot(ctx);
  // A slim context (the journaled form) has no message list; `hydrateContext` rebuilds it.
  const messages = Array.isArray(ctx.messages) ? ctx.messages.map(parseMessage) : [];
  return { ...ctx, ...metadata, ...(snapshot ? { modelSelection: snapshot } : {}), messages };
}

/** The journaled form: everything except the message list, which is re-derived from the transcript up to `uptoSeq`. */
export function slimContext(ctx: BrainContext): BrainContext {
  if (ctx.messages === undefined || typeof ctx.uptoSeq !== 'number') return ctx;
  const { messages: _messages, ...rest } = ctx;
  return rest;
}

/**
 * The full context for a model call. A context that still carries its messages (an older journal)
 * is used as is; a slim one is projected again from the same durable rows (frozen system row,
 * the checkpoint it names, every row up to `uptoSeq`), so the request is byte-identical to the
 * one the build saw.
 */
export async function hydrateContext(store: Store, ctx: BrainContext): Promise<BrainContextData> {
  const parsed = parseContext(ctx);
  if (Array.isArray(ctx.messages) || typeof parsed.uptoSeq !== 'number') return parsed;
  const entries = await readTranscript(store, parsed.sessionKey);
  const checkpoint = typeof parsed.checkpointEpoch === 'number' && parsed.checkpointEpoch >= 0
    ? await readCompaction(store, parsed.sessionKey, parsed.checkpointEpoch)
    : null;
  const upto = parsed.uptoSeq;
  const messages = projectMessages(entries.filter((entry) => isSystemEntry(entry) || entry.seq <= upto), checkpoint, parsed.modelSelection?.supportsImages !== false);
  return { ...parsed, messages };
}

/**
 * System row first, then the checkpoint (recent user messages + summary), then every later row in order; older
 * screenshots pruned in batches (`pruneOldScreenshots`, deterministic from these rows).
 */
export function projectMessages(entries: TranscriptEntry[], checkpoint: Compaction | null, supportsImages: boolean): Message[] {
  const system = findSystemEntry(entries);
  const rows = entries.filter((entry) => !isSystemEntry(entry) && (checkpoint === null || entry.seq > checkpoint.uptoSeq));
  const built = pruneOldScreenshots(buildMessages(system === undefined ? undefined : parseMessage(system.message), checkpoint?.summary, rows, checkpoint?.recentUsers));
  return supportsImages ? built : withoutUserImages(built);
}

/** Limits from an already-built context; unknown fields stay undefined so no threshold is invented. */
export function readContextLimits(ctx: BrainContext): ModelLimits {
  const parsed = z
    .object({ contextWindow: z.number().optional(), maxOutputTokens: z.number().optional() })
    .passthrough()
    .safeParse(ctx);
  if (!parsed.success) return {};
  return knownLimits({ contextWindow: parsed.data.contextWindow, maxOutputTokens: parsed.data.maxOutputTokens });
}

// The behaviour rules the agent runs on (static text, part of the cached prefix). Identity and
// directory facts live as quoted data in the sections below, never interpolated raw into these
// instructions. No workspace prompt is configured anywhere, so this prompt carries no workspace
// persona, organization narrative or specialty claims: only neutral routing facts.
//
// Shape follows Claude Code's own prompt: short imperative rules grouped by situation, and NOTHING
// per-tool — how to call a tool belongs in that tool's description (the browser guidance is in the
// browser tools'), and a specialised workflow (research, page building) in the mission that is loaded
// only when it runs. Reply-shape rules match how the final reply is posted (final-reply.ts); the
// card's JSON shape is the `ui` schema on send_message, not text here. The rules for one kind of run
// travel with it: which chat this is, who reads it and what it can do come from the per-conversation
// "Where you are" section (where-you-are.ts), a helper's rules from its wake text and an automatic
// wake's from its note (messages.ts).
/** How the prompt tells the model to reach a tool that is not in its list: the provider's own search, or the tool_call proxy. */
const HIDDEN_TOOLS_UNIT: Record<ToolSearchMode, HarnessId> = {
  'responses-tool-search': 'system.hidden_tools.responses',
  proxy: 'system.hidden_tools.proxy',
};

/** The frozen behaviour rules for a model that reaches hidden tools in the given way (a different mode is a different model, so the cache restarts anyway). */
const systemPromptFor = (toolSearch: ToolSearchMode): string => [
  harnessText('system.intro'),
  '',
  harnessText('system.working.start'),
  harnessText(HIDDEN_TOOLS_UNIT[toolSearch]),
  harnessText('system.working.rest'),
  '',
  harnessText('system.talking'),
  '',
  harnessText('system.shape'),
  '',
  harnessText('system.helpers'),
  '',
  harnessText('system.facts'),
  '',
  harnessText('system.proactive'),
  '',
  harnessText('system.conflicts'),
].join('\n');

/** Shared room history for group chats as bounded untrusted data ahead of the transcript. Uses the first wake bound to this agent/conversation/session; with no such wake the section is skipped instead of inventing authority. Denials and non-rooms render nothing. */
async function buildRoomHistorySection(store: Store, agentId: string, conversationId: string, sessionKey: string, wakes: WakeEvent[]): Promise<string> {
  const wake = wakes.find((item) => item.agentId === agentId && item.conversationId === conversationId && (item.sessionKey || agentId + ':' + conversationId) === sessionKey);
  if (wake === undefined) return '';
  const room = await buildRoomHistory(store, { agentId, conversationId, sessionKey, wake });
  if (!room.ok || room.details.total === 0) return '';
  return '## Shared room history (untrusted data)\n' + room.text;
}

/** What the owner's devices reported (settings.general): timezone and locale, each only when valid. */
export async function readOwnerDevice(store: Store, ownerId: string | undefined): Promise<{ timezone?: string; locale?: string }> {
  if (ownerId === undefined) return {};
  const row = await safeGet(store, 'settings', settingsIdFor(ownerId));
  const parsed = z.object({ general: z.object({ timezone: z.string().optional(), locale: z.string().optional() }) })
    .safeParse(row.status === 'ok' ? row.doc : undefined);
  if (!parsed.success) return {};
  const { timezone, locale } = parsed.data.general;
  return {
    ...(timezone !== undefined && isTimeZone(timezone) ? { timezone } : {}),
    ...(locale !== undefined && isLocale(locale) ? { locale } : {}),
  };
}

/** The owner's reported IANA timezone; undefined when unset or invalid. */
export async function readOwnerTimeZone(store: Store, ownerId: string | undefined): Promise<string | undefined> {
  return (await readOwnerDevice(store, ownerId)).timezone;
}

/** The owner's local clock for `now`: formatter parts plus a "zone (offset)" label (UTC when unknown). */
async function localClock(store: Store, ownerId: string | undefined, now: Date) {
  const { timezone, locale } = await readOwnerDevice(store, ownerId);
  const zone = timezone ?? 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const where = timezone === undefined ? 'UTC (the user\'s timezone is unknown)' : `${zone} (${part('timeZoneName')})`;
  return { locale, part, where };
}

/**
 * The date section, a snapshot like any other: weekday and date only, so it changes once a day (or
 * when the owner's timezone or locale changes). Models do not know the date on their own (one
 * searched flights a year early). The minute is never in a section, it would end the cached prefix
 * every minute: the exact time travels in the run-start line of the first note of each run.
 */
export async function buildDateSection(store: Store, ownerId: string | undefined, now = new Date()): Promise<string> {
  const { locale, part, where } = await localClock(store, ownerId, now);
  const lines = [`## Current date\nToday for the user: ${part('weekday')} ${part('year')}-${part('month')}-${part('day')}, ${where}.`];
  // The region tells the model the user's currency, units and date format without guessing.
  const region = locale === undefined ? undefined : new Intl.Locale(locale).maximize().region;
  const country = region === undefined ? undefined : new Intl.DisplayNames(['en'], { type: 'region' }).of(region);
  if (locale !== undefined) lines.push(`Their device locale: ${locale}${country ? ` (${country})` : ''}; use its currency, units and date format unless asked otherwise.`);
  return lines.join('\n');
}

/**
 * The first line of a run's first note: the exact local time, whether the user has the app open,
 * and what woke the run (kind, origin, trust; never the wake id, which differs every run).
 */
export async function buildRunStartLine(store: Store, ownerId: string | undefined, agentId: string, wake: WakeEvent[], now = new Date()): Promise<string> {
  const { part, where } = await localClock(store, ownerId, now);
  const lines = [`Run started ${part('weekday')} ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}, ${where}.`];
  const here = await presenceLine(store, ownerId, agentId, now.getTime());
  if (here.length > 0) lines.push(here);
  lines.push(...wakeSummary(wake));
  // The agent's own upcoming one-off items, so it does not double-book and remembers what it promised.
  const calendar = await calendarLine(store, agentId, now, (await readOwnerDevice(store, ownerId)).timezone).catch(() => '');
  if (calendar.length > 0) lines.push(calendar);
  return lines.join('\n');
}

/** One agent text under its own heading (written by the user unless `byline` says otherwise); '' when empty. */
function userTextSection(heading: string, text: string | undefined, byline = ' (written by the user)'): string {
  const body = text?.trim() ?? '';
  return body.length === 0 ? '' : '## ' + heading + byline + '\n' + body;
}

const REACH_OUT_UNITS: Record<'off' | 'less' | 'more', HarnessId> = {
  off: 'reach.off',
  less: 'reach.less',
  more: 'reach.more',
};

/** The reach-out tier as a short line, then the user's own text; either may be missing. */
function reachOutSection(tier: PermissionTiers['reachOut'], text: string | undefined): string {
  const line = tier === undefined || tier === 'normal' ? '' : harnessText(REACH_OUT_UNITS[tier]);
  return userTextSection('When to reach out to the user', [line, text?.trim() ?? ''].filter(part => part.length > 0).join('\n'));
}

/**
 * The Memory section of a run: the items its presence may see (memory/section.ts), read from the memory graph, never from the files.
 * '' when there is no graph (no database) or no owner for the run.
 */
async function memorySection(
  store: Store,
  memory: MemoryPort | undefined,
  run: { ownerId: string | undefined; agentId: string; conversationId: string; wake: WakeEvent[]; dailyLog: string; runStart: boolean; delivered: ReadonlySet<string> },
): Promise<MemorySection> {
  if (memory === undefined || run.ownerId === undefined) return { section: '' };
  const presence = await presenceOf(store, { ownerId: run.ownerId, agentId: run.agentId, conversationId: run.conversationId, wake: run.wake });
  return memory.section({
    ownerId: run.ownerId,
    agentId: run.agentId,
    presence,
    wake: run.wake,
    // A sub-task never writes memory notes; the note instruction also needs the day's log to exist (the computer is reachable).
    canNote: !run.wake.some((item) => item.kind === 'child_task') && run.dailyLog.length > 0,
    people: presence.kind === 'owner' ? await peoplePageList(store, run.ownerId) : [],
    runStart: run.runStart,
    delivered: run.delivered,
  });
}

async function buildUserDetails(store: Store, audience: ProfileAudience): Promise<string> {
  const details = profileSection(await readProfile(store, audience.profileOwnerId), audience.ownerOnly);
  // Vault labels are only for runs that serve the owner alone.
  const vault = audience.ownerOnly ? vaultSection(await readVaultEntries(store, audience.profileOwnerId)) : '';
  return [details, vault].filter((part) => part.length > 0).join('\n\n');
}

/**
 * Build the model context for a step as an append-only history. See context-notes.ts for the model:
 * a frozen system row (written once per session), then the transcript, with one `<context_update>`
 * note appended whenever a section's text differs from what the model last saw. `previousContext`
 * marks a mid-run rebuild (no run-start line). `noteKey` makes the note row id deterministic per
 * run and step, so a re-executed build rewrites the same row instead of adding a second.
 * `toolNames` are the tools discovered now; their persisted order is merged and carried forward.
 */
type BuildContextOpts = {
  platformSkills?: Pick<PlatformSkillsService, 'catalog'>;
  agentId: string; conversationId: string; sessionKey: string; wake: WakeEvent[];
  environment?: ComputerEnvironmentSource;
  provider?: LimitsAwareProvider;
  modelSelection?: ModelSelection;
  previousContext?: BrainContext;
  noteKey?: string;
  toolNames?: string[];
  /** The user's computer home (identity, memory, skills as files); absent means the mirror alone feeds those sections. */
  home?: Pick<HomeDeps, 'home' | 'log' | 'skills'> & { memory?: MemoryPort };
  /** Static system-prompt sections the host's plugins added, already in order; appended to the frozen rules. */
  promptSections?: readonly string[];
  /** The connector catalog, for the one-line description of each app the agent can use. */
  connectorCatalog?: ConnectorCatalog;
  /** Resolves the harness version the session is pinned to (BACKEND §11.2); absent reads the active version. */
  harness?: HarnessPins;
};

/**
 * The version this session reads (BACKEND §11.2): the one its frozen system row names, else the active one. Everything the build
 * reads from the harness (the frozen rules, note texts, the rules-updated note) comes from that version.
 */
export async function buildContext(store: Store, opts: BuildContextOpts): Promise<BrainContextData> {
  const version = await sessionHarnessVersion(opts.harness, await readTranscript(store, opts.sessionKey));
  return withHarnessVersion(version, () => buildContextAt(store, opts, version));
}

async function buildContextAt(store: Store, opts: BuildContextOpts, version: HarnessVersion): Promise<BrainContextData> {
  const { agentId, conversationId, sessionKey } = opts;
  const agent = await store.get('agents', agentId);
  const role = agent ? meaningfulRole(agent.title) : undefined;
  const profile = agent
    ? '## Agent: ' + quoteLabel(agent.name) + (role === undefined ? '' : '\nRole: ' + quoteLabel(role))
      + ((agent.description ?? '').trim() === '' ? '' : '\nDescription: ' + quoteLabel(agent.description?.trim()))
    : '## Agent: ' + quoteLabel(agentId);
  const runs = await store.list('runs', { where: { agentId, conversationId }, limit: 1, orderBy: 'at', order: 'desc' });
  const runEpoch = z.object({ compactionEpoch: z.number().default(0) }).parse(runs.items[0] ?? {}).compactionEpoch;
  const entries = await readTranscript(store, sessionKey);
  const checkpoint = await readLatestCompaction(store, sessionKey);
  // The durable checkpoint, not just the latest run row, is the source of truth for the epoch.
  const epoch = Math.max(runEpoch, checkpoint?.epoch ?? 0);
  const ownerId = opts.wake.find((item) => (item.sessionKey || agentId + ':' + conversationId) === sessionKey)?.ownerId;
  // Sections are rendered fresh on every build; only a difference from the delivered text reaches the model.
  const identity = currentIdentityLines(agent === null ? undefined : { name: agent.name, title: agent.title }, agentId).join('\n');
  const home = await resolveHome(store, opts, ownerId, agent === null ? undefined : docOwner(agent), entries);
  // No persona and no principles from the owner: the default persona speaks instead (never mixed with theirs).
  const ownPersona = (home.persona ?? '').trim().length > 0 || (home.principles ?? '').trim().length > 0;
  const agentTexts = [
    ownPersona ? userTextSection('Agent persona', home.persona) : userTextSection('Agent persona (default)', harnessText('persona.default'), ''),
    userTextSection('Agent principles and tone', home.principles),
    userTextSection('Agent working instructions', home.instructions),
    userTextSection('Agent tool notes', home.toolNotes),
    reachOutSection(agent?.permissionTiers?.reachOut, home.reachOut),
  ];
  // Who this run serves, worked out once per build: the owner's private texts (about them, learned style,
  // memory below) are loaded only when no one besides the owner is in the run; the "Where you are" section says so in a shared run.
  const audience = await profileAudience(store, { agentId, conversationId, wake: opts.wake });
  const aboutUser = !audience.ownerOnly ? '' : userTextSection('About the user', home.aboutUser);
  // Learned from past chats for every agent; this agent's persona above sets the voice and wins where they differ.
  const alignment = !audience.ownerOnly ? '' : userTextSection('How this user likes to be answered (learned)', home.alignment === '' ? '' : home.alignment + '\n(Your persona sets your voice and tone; where this differs, follow the persona.)', '');
  // The frozen system message: behavior rules plus what the user wrote about the agent and themselves.
  // Nothing that changes during a session lives here; an edit arrives as a `profile` update note.
  // The account model is resolved once per new run. A rebuild carrying the previous journaled
  // context keeps its frozen snapshot (and that snapshot's limits) instead of re-resolving the
  // current setting, so steering or tool refresh never swaps the model mid-run. It comes first because
  // the frozen rules depend on how the model reaches hidden tools.
  const retained = opts.previousContext === undefined ? undefined : parseModelSnapshot(opts.previousContext);
  const { lane, fast } = retained === undefined
    ? await sessionLane(store, { agentId, conversationId, sessionKey }, opts.wake, z.object({ kind: z.string() }).safeParse(runs.items[0]).data?.kind)
    : { lane: 'chat' as const, fast: false };
  const frozen = await resolveFrozenModel(opts.modelSelection, agentId, retained, lane, fast);  // Plugin sections are static text fixed at process start and ordered by the host: part of the frozen prompt, never per run.
  const systemPrompt = [systemPromptFor(frozen?.snapshot.toolSearch ?? 'proxy'), ...(opts.promptSections ?? [])].join('\n\n');
  const systemText = [systemPrompt, profile, ...agentTexts, aboutUser, alignment, identity].filter(part => part.length > 0).join('\n\n');
  // The memory items this session's notes already delivered (their `items` meta) are not delivered again; a run's first build may add some.
  const delivered = deliveredItemIds(entries);
  const memoryPart = await memorySection(store, opts.home?.memory, { ownerId, agentId, conversationId, wake: opts.wake, dailyLog: home.dailyLog, runStart: opts.previousContext === undefined, delivered });
  const current: SectionTexts = {
    profile: harnessText('profile.update') + '\n\n' + systemText,
    where: await buildWhereSection(store, { agentId, conversationId, sessionKey, wake: opts.wake, audience, hasComputer: opts.environment !== undefined, ...(opts.connectorCatalog === undefined ? {} : { catalog: opts.connectorCatalog }) }),
    groupNote: await buildGroupNoteSection(store, { agentId, conversationId, sessionKey, wake: opts.wake }),
    date: await buildDateSection(store, ownerId),
    session: await buildSocialContext(store, { agentId, conversationId, sessionKey, wake: opts.wake }),
    team: await buildTeamSection(store, { agentId, conversationId, sessionKey, wake: opts.wake, ownerOnly: audience.ownerOnly }),
    room: await buildRoomHistorySection(store, agentId, conversationId, sessionKey, opts.wake),
    memory: memoryPart.section,
    goals: audience.ownerOnly ? await buildGoalSection(store, agentId, ownerId) : '',
    skills: await buildSkillsSection({ store, ownerId, ...(opts.platformSkills === undefined ? {} : { platformSkills: opts.platformSkills }), ...(opts.home?.skills === undefined ? {} : { skills: opts.home.skills }) }, agentId, home.platformSkills),
    tasks: await buildTaskSection(store, agentId, conversationId, sessionKey),
    userDetails: await buildUserDetails(store, audience),
    computerFacts: await buildComputerFacts(agentId, opts.environment, agent?.macAccess === true),
    computer: opts.environment === undefined ? '' : buildComputerRules(agent?.macAccess === true),
    phone: audience.ownerOnly ? await buildPhoneSection(store, ownerId) : '',
    artifacts: await buildArtifactsSection(store, agentId, conversationId),
  };

  // The frozen system row: written once. Its tool order is the only part that moves during normal
  // operation. A new SYSTEM_PROMPT version rewrites the text exactly once, so a conversation that
  // outlives a prompt change does not carry the old instructions alongside the new ones — that is one
  // deliberate cache miss, not a per-run cost. The other sections stay as they were delivered. Older
  // messages were written under the old rules, so the same build also appends one note saying the rules
  // changed (rulesUpdatedNote, context.rules_updated); history is only appended to, never rewritten. Between a tool call and its
  // result nothing can be appended, so the rewrite waits for the next build and the note is never lost.
  let systemEntry = findSystemEntry(entries);
  const rows = entries.filter((entry) => !isSystemEntry(entry));
  const projected = checkpoint === null ? rows : rows.filter((entry) => entry.seq > checkpoint.uptoSeq);
  let rulesUpdated = false;
  const storedMeta = systemEntry === undefined ? undefined : metaOf(systemEntry.message);
  const knownOrder = storedMeta?.toolOrder
    ?? (Array.isArray(opts.previousContext?.toolOrder) ? opts.previousContext.toolOrder.filter((name): name is string => typeof name === 'string') : undefined);
  const toolOrder = opts.toolNames === undefined ? knownOrder : mergeToolOrder(knownOrder, opts.toolNames);
  // The tools offered follow who is present (batch 5b), decided once per conversation: the frozen row's scope wins over who is here now.
  const presence = await presenceOf(store, { ownerId, agentId, conversationId, wake: opts.wake });
  const toolScope = resolveToolScope(storedMeta?.toolScope, readToolScope(opts.previousContext?.['toolScope']), scopeOfPresence(presence));
  const promptHash = hashText(systemPrompt);
  if (systemEntry === undefined) {
    const [created] = await appendToTranscript(store, sessionKey, [systemMessage(systemText, hashText(current.profile), toolOrder, promptHash, toolScope, version.id)], 'system', entries);
    if (created === undefined) throw new Error('context: the system row was not written');
    systemEntry = created;
    entries.push(created);
  } else {
    const orderMoved = toolOrder !== undefined && JSON.stringify(toolOrder) !== JSON.stringify(storedMeta?.toolOrder);
    // A row written before the scope existed gets it once, from who is present at its next build.
    const scopeMoved = storedMeta?.toolScope !== toolScope;
    const promptMoved = storedMeta?.promptHash !== promptHash && !hasPendingToolCall(projected);
    rulesUpdated = promptMoved && rows.length > 0;
    // A row written before harness versions existed is pinned now, to the version that builds it (the seed, so far).
    const pinMissing = storedMeta !== undefined && storedMeta.harnessVersion === undefined;
    if (orderMoved || promptMoved || scopeMoved || pinMissing) {
      const meta = {
        ...storedMeta,
        harnessVersion: storedMeta?.harnessVersion ?? version.id,
        // The row now carries the current profile text, so record its hash instead of re-delivering it as a note.
        ...(promptMoved ? { sections: { ...(storedMeta?.sections ?? {}), profile: hashText(current.profile) }, promptHash } : {}),
        ...(toolOrder === undefined ? {} : { toolOrder }),
        toolScope,
      };
      const rewritten: TranscriptEntry = { ...systemEntry, message: { ...systemEntry.message, ...(promptMoved ? { content: systemText } : {}), contextMeta: meta } };
      await store.put('transcripts', rewritten);
      const at = entries.findIndex((entry) => entry.id === rewritten.id);
      if (at >= 0) entries[at] = rewritten;
      else entries.push(rewritten);
      systemEntry = rewritten;
    }
  }

  // Append the note: changed sections (everything, on a fresh session or after a compaction) and,
  // at the start of a run, the exact time and what woke it. After the last tool result, never inside a pair.
  const runStart = opts.previousContext === undefined
    ? await buildRunStartLine(store, ownerId, agentId, opts.wake)
    : undefined;
  const changes = diffSections(current, deliveredHashes(systemEntry, projected));
  // What a run actually re-sends, and how big it is: without this the only visible number is the
  // total context size, so "why did this cost so much" has to be guessed at.
  if (changes.texts.length > 0) {
    opts.home?.log?.(
      { agentId, sessionKey, sections: Object.keys(changes.hashes), chars: changes.texts.reduce((sum, text) => sum + text.length, 0), systemChars: systemText.length, tools: toolOrder?.length ?? 0 },
      'context sections re-sent',
    );
  }
  // A re-executed build (crash between the write and its journal entry) finds its own row and keeps it as written.
  const noteId = opts.noteKey === undefined ? undefined : `tx_${sessionKey}_${opts.noteKey}_0`;
  const written0 = noteId !== undefined && rows.some((row) => row.id === noteId);
  // The run's relevant memory (past the section's limit) rides in the same note, after the changed sections, with its ids recorded.
  const relevant = memoryPart.relevant;
  if (!written0 && (changes.texts.length > 0 || runStart !== undefined || rulesUpdated || relevant !== undefined) && !hasPendingToolCall(projected)) {
    const sectionTexts = relevant === undefined ? changes.texts : [...changes.texts, relevant.text];
    const texts = rulesUpdated ? [rulesUpdatedNote(), ...sectionTexts] : sectionTexts;
    const written = await appendToTranscript(store, sessionKey, [noteMessage(renderNote(runStart, texts), changes.hashes, relevant?.ids ?? [])], opts.noteKey, entries);
    // A re-executed build rewrites its own row (same id): replace it rather than listing it twice.
    for (const entry of written) {
      const at = rows.findIndex((row) => row.id === entry.id);
      if (at >= 0) rows[at] = entry;
      else rows.push(entry);
    }
  }

  const limits = frozen ? await readProviderLimits(frozen.provider) : await readProviderLimits(opts.provider);
  const messages = projectMessages([systemEntry, ...rows], checkpoint, frozen === undefined || frozen.snapshot.supportsImages);
  return {
    sessionKey,
    agentId,
    messages,
    systemPrompt,
    compactionEpoch: epoch,
    uptoSeq: rows.reduce((top, entry) => Math.max(top, entry.seq), -1),
    checkpointEpoch: checkpoint?.epoch ?? -1,
    contextTokens: estimateMessagesTokens(messages),
    ...(toolOrder === undefined ? {} : { toolOrder }),
    toolScope,
    ...(frozen ? { modelSelection: frozen.snapshot } : {}),
    ...limits,
    home,
    harnessVersion: version.id,
  };
}

/** Tools that can change files in the home (BACKEND §5.3): after one of them the snapshot is taken again. */
const FILE_CHANGING_TOOLS = new Set(['files.write', 'files.edit']);

function changedFilesSince(entries: TranscriptEntry[], seq: number): boolean {
  return entries.some((entry) => entry.seq > seq && entry.message['role'] === 'assistant' && Array.isArray(entry.message['content']) && entry.message['content'].some((block: unknown) => {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'toolCall') return false;
    const name = Reflect.get(block, 'name');
    return typeof name === 'string' && (FILE_CHANGING_TOOLS.has(name) || name.startsWith('shell.'));
  }));
}

/**
 * The home view: a snapshot once per run (no previous context), then only after a step that ran a file-changing tool;
 * otherwise the previous context's view carries over. Runs inside the journaled context step, so a replay never reaches the computer.
 */
async function resolveHome(
  store: Store,
  opts: { agentId: string; previousContext?: BrainContext; home?: Pick<HomeDeps, 'home' | 'log' | 'skills'> & { memory?: MemoryPort } },
  ownerId: string | undefined,
  agentOwnerId: string | undefined,
  entries: TranscriptEntry[],
): Promise<HomeView> {
  if (ownerId === undefined) return EMPTY_HOME_VIEW;
  const previous = homeViewSchema.safeParse(opts.previousContext?.['home']);
  if (previous.success && !changedFilesSince(entries, previous.data.seq)) return previous.data;
  const seq = entries.reduce((top, entry) => Math.max(top, entry.seq), -1);
  const timeZone = await readOwnerTimeZone(store, ownerId);
  return loadHomeView({ store, ...opts.home }, { ownerId, ...(agentOwnerId === undefined ? {} : { agentOwnerId }), agentId: opts.agentId, seq, sync: true, ...(timeZone === undefined ? {} : { timeZone }) });
}

/** Wakes that run on their own schedule and are never a person waiting for a reply. */
const BACKGROUND_WAKES: ReadonlySet<string> = new Set(['routine', 'monitor', 'goal_checkin', 'calendar_due', 'webhook', 'connector_event']);

/**
 * The reasoning lane of a session, fixed for the conversation's life so its requests keep one effort (the cache is
 * keyed per effort). A child run is a child, `deep` when child_spawn asked for it, and `fast` when it asked for the fast
 * model (both fixed on its reserved row). Any other session is a routine when its run or wake is a routine/monitor/
 * automation one, else a chat.
 */
async function sessionLane(
  store: Store,
  session: { agentId: string; conversationId: string; sessionKey: string },
  wake: readonly WakeEvent[],
  latestRunKind: string | undefined,
): Promise<{ lane: EffortLane; fast: boolean }> {
  const childRunId = childRunIdOfSession(session.sessionKey, session.agentId, session.conversationId);
  if (childRunId === undefined) {
    const automated = latestRunKind === 'routine' || wake.some((item) => BACKGROUND_WAKES.has(item.kind));
    return { lane: automated ? 'routine' : 'chat', fast: false };
  }
  const row = z.object({ fastModel: z.literal(true).optional(), deepEffort: z.literal(true).optional() }).safeParse(await store.get('runs', childRunId));
  const flags = row.success ? row.data : {};
  return { lane: flags.deepEffort === true ? 'deep-child' : 'child', fast: flags.fastModel === true };
}

/**
 * Resolve the run's frozen model: retain the journaled snapshot or resolve the account choice for the run's lane. A `fast`
 * run (a child started with child_spawn `fast`) takes the owner's own fast model, else the platform's; with neither it runs
 * on the normal model. The cheap-marked and agent-model fallbacks of the background calls do not count as a fast choice here.
 */
export async function resolveFrozenModel(
  selection: ModelSelection | undefined,
  agentId: string,
  retained: ModelSnapshot | undefined,
  lane: EffortLane = 'chat',
  fast = false,
): Promise<{ snapshot: ModelSnapshot; provider: LimitsAwareProvider } | undefined> {
  if (selection === undefined) return undefined;
  if (retained !== undefined) return { snapshot: retained, provider: selection.providerFor(retained) };
  if (fast) {
    const picked = await selection.resolveFast?.(currentOwnerId(), lane);
    if (picked !== undefined && picked.source !== 'agent') {
      return { snapshot: picked.snapshot, provider: selection.providerFor(picked.snapshot) };
    }
  }
  const snapshot = await selection.resolve(agentId, lane);
  return { snapshot, provider: selection.providerFor(snapshot) };
}

export async function readProviderLimits(provider: LimitsAwareProvider | undefined): Promise<ModelLimits> {
  const getLimits = provider?.getLimits?.bind(provider);
  if (getLimits === undefined) return {};
  try {
    return knownLimits(await getLimits());
  } catch {
    return {};
  }
}
