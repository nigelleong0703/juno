/**
 * The daily ideas job (BACKEND §5.10), after Muse's background jobs that "prepare ideas or goal briefings": once a day one model
 * call reads what the assistant knows about the user (memory, people, goals and their timelines, the conversations since the last
 * run, how to talk to them) and proposes one to three ideas, each tied to its source and to an agent that can really do it.
 * Code, not the model, decides what is kept: the capability gate drops ideas the agent could not carry out, the dedupe (cooldown.ts)
 * drops what was handled, waiting, dismissed, snoozed or ignored recently (by topic + action key, not wording), and the owner's hard
 * `never` rules (modules/proactive) drop what they said never to hear about. Soft rules go to the model as guidance.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Agent, Idea } from '@agent-desktop/public-contracts';
import { sessionKey, type Store, type ToolRegistry, type WakeEvent } from '../../contracts/index.js';
import { readOwnerTimeZone } from '../../execution/brain/context.js';
import { docOwner } from '../../execution/execution-owner.js';
import { harnessText } from '../harness/loader.js';
import { readProfile } from '../profile/index.js';
import { getRow, readRowsUnder } from '../home/mirror.js';
import { ALIGNMENT_FILE, MEMORY_FILE, localDate, localTime } from '../home/paths.js';
import type { HomeDeps } from '../home/service.js';
import { editHomeFile } from '../memory/files.js';
import { blockingRule, rulesText } from '../proactive/rules.js';
import { migrateRules, ownerLog, readRules, roomOn, rulesForWake } from '../proactive/service.js';
import { askIfSilent } from '../proactive/silence.js';
import { itemsSince, type SourceItem } from '../memory/jobs/gather.js';
import { jobAgent } from '../memory/jobs/agent.js';
import { jsonObjectIn } from '../memory/jobs/model-json.js';
import type { JobModel, JobOutcome } from '../memory/jobs/types.js';
import { recordJobUsage } from '../memory/jobs/usage.js';
import type { ConnectorCatalog } from '../mcp/index.js';
import { listAll } from '../memory/util.js';
import { connectedCatalog } from '../tasks/routines/capabilities.js';
import { blockedReason, ideaKey, recentIdeas } from './cooldown.js';
import { missingCapabilities } from './gate.js';
import { planSendTime, readDailyCheck } from './schedule.js';
import { alreadyHandled, expireIgnored } from './state.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ideas per run, and ideas waiting at once. */
export const MAX_NEW_IDEAS = 3;
/** Notices planned per run (the daily cap of unsolicited messages still applies when each is posted). */
export const MAX_NOTICES = 3;
export const MAX_OPEN_IDEAS = 6;
/** Characters of conversation shown per run, and how far back the first run looks. */
const SOURCE_CHARS = 30_000;
const FIRST_LOOKBACK_DAYS = 7;
const FILE_CHARS = 12_000;
const GOAL_TIMELINE_ENTRIES = 5;

/** What the job reads beyond the user's own files: connected-app data from read-only tools. Connectors plug in here. */
export interface ConnectorContext {
  label: string;
  text: string;
}

export interface IdeasDeps extends HomeDeps {
  model: JobModel;
  /** The connectors this deployment offers: the apps an idea may ask the user to connect. */
  catalog: ConnectorCatalog;
  /** The registry the agents run with: its `forAgent` is what an agent can do, MCP and connector tools included. */
  tools: Pick<ToolRegistry, 'forAgent'>;
  /** Extension point for connectors: read-only snapshots (new mail, unusual expenses…) the model may base ideas on. */
  connectorContext?: (ownerId: string) => Promise<ConnectorContext[]>;
  now?: () => Date;
}

export interface IdeasCheckpoint {
  /** `at` of the newest message read. */
  itemsAt?: string;
  /** Hash of everything else the last run read, so an unchanged day costs nothing. */
  inputHash?: string;
  /** The user's local date it last ran for. */
  date?: string;
}

export interface IdeasResult {
  outcome: JobOutcome;
  checkpoint: IdeasCheckpoint;
  saved: Idea[];
  dropped: string[];
  /** The notices the model found worth interrupting the user for, each a wake to deliver at its own `at` (the planned send time); none on most days. */
  wakes: WakeEvent[];
}

const candidateSchema = z.object({
  topic: z.string().trim().min(1).max(80),
  /** One verb for what the assistant would do ("draft", "book", "remind", "summarise"); with the topic it is the idea's stable key. */
  verb: z.string().trim().max(30).default(''),
  title: z.string().trim().min(1).max(160),
  why: z.string().trim().min(1).max(300),
  agentId: z.string().min(1),
  /** The conversation the idea comes from, when it comes from one (not from a goal, memory or a connector). */
  conversationId: z.string().min(1).optional(),
  prompt: z.string().trim().min(1).max(2_000),
  requires: z.array(z.string()),
  prepared: z.object({ title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(8_000) }).optional(),
});
type Candidate = z.infer<typeof candidateSchema>;
/**
 * A notice is about something the user said in one conversation: that conversation (and its agent) is where it is followed up.
 * `sendAt` (ISO time with offset, or HH:MM) is when the model wants it sent and `whenWhy` why then; code bounds the time (`planSendTime`).
 */
const noticeSchema = z.object({ text: z.string().trim().min(1).max(500), conversationId: z.string().min(1), sendAt: z.string().trim().min(1).max(40).optional(), whenWhy: z.string().trim().max(300).default('') });
type Notice = z.infer<typeof noticeSchema>;

const clip = (text: string): string => (text.length > FILE_CHARS ? text.slice(0, FILE_CHARS) : text);

/** Agent lines for the prompt: the tools every agent has once, then each agent's own list, so the prompt stays short. */
function renderAgents(agents: ReadonlyArray<{ agent: Agent; tools: ReadonlySet<string> }>): string {
  const [first, ...rest] = agents;
  if (first === undefined) return '';
  const common = [...first.tools].filter((name) => rest.every((other) => other.tools.has(name)));
  const lines = agents.map(({ agent, tools }) => '- ' + agent.id + ' (' + agent.name + ', ' + agent.title + '): ' + ([...tools].filter((name) => !common.includes(name)).join(', ') || 'only the common tools'));
  return 'Tools every assistant has: ' + common.join(', ') + '\nAssistants (with the tools beyond those):\n' + lines.join('\n');
}

const slug = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'draft';

/** `drafts/<date>-<slug>.md`, never overwriting a draft that is already there. */
async function draftPath(deps: HomeDeps, ownerId: string, date: string, title: string): Promise<string> {
  const base = 'drafts/' + date + '-' + slug(title);
  for (let n = 1; ; n += 1) {
    const path = base + (n === 1 ? '' : '-' + String(n)) + '.md';
    if ((await getRow(deps.store, ownerId, path)) === null) return path;
  }
}

/**
 * The agent a conversation belongs to: the one in a direct or peer chat, else (a room) the agent that last spoke in it among `items`.
 * Undefined when the conversation is not the owner's or no one can be named.
 */
async function conversationAgents(store: Store, items: readonly SourceItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(items.map((item) => item.conversationId))) {
    const chat = await store.get('conversations', id);
    const speaker = [...items].reverse().find((item) => item.conversationId === id && item.role === 'agent' && item.agentId !== undefined)?.agentId;
    const agentId = chat === null ? undefined : chat.kind === 'direct' || chat.kind === 'peer' ? chat.agentIds[0] : chat.agentIds.includes(speaker ?? '') ? speaker : undefined;
    if (agentId !== undefined) out.set(id, agentId);
  }
  return out;
}

/**
 * The background wake a planned notice becomes: the agent whose conversation the notice came from, in that conversation (never another
 * agent, never a new or platform chat picked by order), with a check to make. The agent verifies with its own tools and decides whether to message; the owner's proactive rules ride in the wake text (appended, never the frozen prompt).
 * `sendAt` is when it is delivered (its `at`), the text says that time. The id is fixed per local date and item, so a retry of the same day starts nothing twice.
 */
async function noticeWake(store: Store, ownerId: string, agent: Agent, notice: Notice, date: string, sendAt: Date, timeZone: string | undefined, now: Date): Promise<WakeEvent> {
  const rules = await rulesForWake(store, ownerId, now);
  const text = harnessText('job.ideas.notice_wake', { date: localDate(sendAt, timeZone), time: localTime(sendAt, timeZone), zone: timeZone === undefined ? '' : ' (' + timeZone + ')', check: notice.text, whenWhy: notice.whenWhy === '' ? '' : ' Why now: ' + notice.whenWhy })
    + (rules === '' ? '' : '\n\n' + rules);
  const item = createHash('sha256').update(notice.conversationId + '\n' + notice.text).digest('hex').slice(0, 8);
  return {
    id: 'wake_proactive_' + ownerId + '_' + date + '_' + item, ownerId, agentId: agent.id, sessionKey: sessionKey(agent.id, notice.conversationId), conversationId: notice.conversationId,
    kind: 'goal_checkin', origin: { type: 'automation', id: 'proactive-check', label: 'Daily check' }, trusted: true, priority: 'background',
    payload: { title: 'Daily check', reason: 'proactive', text }, at: sendAt.toISOString(), status: 'accepted',
  };
}

export async function runDailyIdeas(
  deps: IdeasDeps,
  input: { ownerId: string; checkpoint: IdeasCheckpoint; force?: boolean },
): Promise<IdeasResult> {
  const { store, model } = deps;
  const { ownerId, checkpoint } = input;
  const now = (deps.now ?? (() => new Date()))();
  const timeZone = await readOwnerTimeZone(store, ownerId);
  const date = localDate(now, timeZone);
  const unchanged = (outcome: JobOutcome, dropped: string[] = []): IdeasResult => ({ outcome, checkpoint, saved: [], dropped, wakes: [] });
  // The owner switched the daily check off: no ideas and no notice, whatever asked for the run (the schedule keeps ticking, so switching it on again needs no re-arming).
  const dailyCheck = await readDailyCheck(store, ownerId);
  if (!dailyCheck.enabled) return unchanged('skipped');
  if (input.force !== true && checkpoint.date === date) return unchanged('skipped');
  const target = await jobAgent(store, ownerId, deps.log);
  if (target === undefined) return unchanged('skipped');

  // What the job can offer: agents allowed to reach out, with what each can do right now.
  const hasComputer = deps.home !== undefined;
  const capable: Array<{ agent: Agent; tools: ReadonlySet<string>; mcpTools: ReadonlySet<string> }> = [];
  for (const agent of target.agents) {
    if (agent.permissionTiers?.reachOut === 'off') continue;
    const tools = await deps.tools.forAgent(agent.id);
    capable.push({ agent, tools: new Set(tools.map((tool) => tool.name)), mcpTools: new Set(tools.filter((tool) => tool.mcp === true).map((tool) => tool.name)) });
  }
  if (capable.length === 0) return unchanged('skipped');

  // The owner's proactive rules: an old free-text file is converted once, here. Ideas that stayed open for 14 days count as ignored,
  // and five ignored in a row (or five unread messages of a type) raise the "Want fewer of these?" question.
  await migrateRules(deps, ownerId);
  const rules = await readRules(store, ownerId);
  const allIdeas = await expireIgnored(store, (await listAll(store, 'ideas')).filter((idea) => docOwner(idea) === ownerId), now);
  await askIfSilent(deps, { ownerId, agentId: target.agent.id, now });
  const rows = await readRowsUnder(store, ownerId, '');
  const file = (path: string): string => clip(rows.find((row) => row.path === path)?.content.trim() ?? '');
  const people = rows.filter((row) => row.path.startsWith('people/')).sort((a, b) => a.path.localeCompare(b.path)).map((row) => '### ' + row.path + '\n' + clip(row.content.trim()));
  const goals = (await listAll(store, 'goals')).filter((goal) => docOwner(goal) === ownerId && goal.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const goalLines = goals.map((goal) => '- ' + goal.title + ' [' + goal.kind + ', agent ' + goal.agentId + ']: ' + goal.summary
    + (goal.steps === undefined ? '' : ' (' + goal.steps.filter((step) => step.done).length + '/' + goal.steps.length + ' steps)')
    + (goal.activity ?? []).slice(0, GOAL_TIMELINE_ENTRIES).map((entry) => '\n    ' + entry.at.slice(0, 10) + ' ' + entry.text).join(''));
  const after = checkpoint.itemsAt ?? new Date(now.getTime() - FIRST_LOOKBACK_DAYS * DAY_MS).toISOString();
  const items = (await itemsSince(store, ownerId, after, SOURCE_CHARS)).filter((item) => item.role !== 'other');
  const connectors = (await deps.connectorContext?.(ownerId)) ?? [];
  const address = (await readProfile(store, ownerId))?.entries.find((entry) => /home.*address|^address$/i.test(entry.key.trim()));

  const material = [
    '## MEMORY.md\n' + (file(MEMORY_FILE) || '(empty)'),
    '## People\n' + (people.join('\n\n') || '(none)'),
    '## Active goals\n' + (goalLines.join('\n') || '(none)'),
    '## Where the user is\n' + ([timeZone === undefined ? '' : 'time zone ' + timeZone, address === undefined ? '' : 'home: ' + address.value.split('\n').map((line) => line.trim()).filter(Boolean).join(', ')].filter((part) => part.length > 0).join('; ') || '(unknown)'),
    '## Proactive preferences\n' + (rulesText(rules, date) || '(none)'),
    '## How to talk to this user (ALIGNMENT_SYNTHESIS.md)\n' + (file(ALIGNMENT_FILE) || '(none)'),
    ...connectors.map((source) => '## ' + source.label + ' (connected app, read-only)\n' + clip(source.text)),
  ].join('\n\n');
  const inputHash = createHash('sha256').update(material).digest('hex');
  if (input.force !== true && items.length === 0 && checkpoint.inputHash === inputHash) return unchanged('skipped');
  if (checkpoint.itemsAt === undefined && items.length === 0 && goals.length === 0 && people.length === 0 && connectors.length === 0 && file(MEMORY_FILE) === '') return unchanged('skipped');

  // Earlier ideas and what the owner already has going: the model is told, and the code enforces the dedupe again below.
  // Catalog apps the owner has not connected: the model may base an idea on one, and the user is asked to connect it. Keyed apps are on for everyone, so never listed.
  const connectedApps = connectedCatalog((await listAll(store, 'connections')).filter((connection) => docOwner(connection) === ownerId));
  const unconnected = new Map(deps.catalog.list().filter((entry) => entry.platformKey !== true && !connectedApps.has(entry.id)).map((entry) => [entry.id, entry]));
  const open = allIdeas.filter((idea) => idea.status === 'open');
  const earlier = recentIdeas(allIdeas, now);
  const snoozed = (await ownerLog(store, ownerId, ['snooze'])).filter((row) => row.until !== undefined && row.until > now.toISOString() && row.topic !== undefined).map((row) => row.topic ?? '');
  const handled = await alreadyHandled(store, ownerId, new Set(target.agents.map((agent) => agent.id)), now);
  const room = Math.max(0, Math.min(MAX_NEW_IDEAS, MAX_OPEN_IDEAS - open.length));
  const chatAgent = await conversationAgents(store, items);
  const nameOf = (agentId: string | undefined): string => target.agents.find((agent) => agent.id === agentId)?.name ?? 'unknown';

  const startedAt = new Date();
  const reply = await model.complete({
    agentId: target.agent.id, sessionKey: 'ideas:daily:' + ownerId, system: harnessText('job.ideas.system'),
    prompt: [
      'Now is ' + date + ' ' + localTime(now, timeZone) + (timeZone === undefined ? ' (the user\'s time zone is unknown; use UTC)' : ' in ' + timeZone + ' (the user\'s local time)') + '. Quiet hours (nothing is sent then): ' + dailyCheck.quiet.from + ' to ' + dailyCheck.quiet.to + '.',
      material,
      '## Conversations since the last run\n' + (items.map((item) => (item.role === 'user' ? 'USER ' : 'ASSISTANT ') + item.at + ' (conversation ' + item.conversationId + ', with ' + nameOf(chatAgent.get(item.conversationId)) + '): ' + item.text).join('\n') || '(none)'),
      '## Assistants and their tools\n' + renderAgents(capable),
      '## Apps the user has not connected yet (put the id in "requires" when an idea needs one)\n' + ([...unconnected.values()].map((entry) => '- ' + entry.id + ': ' + entry.name + ', ' + entry.description).join('\n') || '(none)'),
      '## Offered before (waiting, handled, dismissed, snoozed or ignored: do not offer again)\n' + (earlier.map((idea) => '- ' + idea.text + (idea.topic === undefined ? '' : ' [' + idea.topic + ']') + ' (' + idea.standing + ')').join('\n') || '(none)'),
      '## Already being handled by the user (do not offer to start these)\n' + handled,
      room === 0 ? 'Propose no ideas (too many are waiting).' : 'Propose at most ' + String(room) + ' idea' + (room === 1 ? '' : 's') + '.',
    ].join('\n\n'),
  });
  if (reply === null) return unchanged('failed');
  await recordJobUsage(store, { ownerId, agentId: target.agent.id, label: 'Ideas: daily', reply, startedAt, finishedAt: new Date() });
  const json = jsonObjectIn(reply.text);
  const parsed = z.object({ ideas: z.array(z.unknown()) }).safeParse(json);
  if (!parsed.success) return unchanged('failed');
  const asked = json as { notice?: unknown; notices?: unknown } | undefined;
  const noticeRaw = Array.isArray(asked?.notices) ? asked.notices : asked?.notice === undefined ? [] : [asked.notice];

  const dropped: string[] = [];
  const saved: Idea[] = [];
  const kept: Candidate[] = [];
  for (const raw of parsed.data.ideas) {
    const candidate = candidateSchema.safeParse(raw);
    if (!candidate.success) {
      dropped.push('malformed idea');
      continue;
    }
    const idea = candidate.data;
    const who = capable.find(({ agent }) => agent.id === idea.agentId);
    // An unconnected app is not a missing tool: the idea stays, and its reason names the app to connect.
    const apps = idea.requires.flatMap((id) => unconnected.get(id) ?? []);
    const toolNeeds = idea.requires.filter((id) => !unconnected.has(id));
    const missing = who === undefined ? ['no such agent that may reach out'] : missingCapabilities(toolNeeds, { tools: who.tools, mcpTools: who.mcpTools, computer: hasComputer, ...(who.agent.permissionTiers === undefined ? {} : { tiers: who.agent.permissionTiers }) });
    const key = ideaKey(idea.topic, idea.verb);
    const asIdea = { text: idea.title, topic: idea.topic, key };
    // This run's earlier picks count as waiting, so two rewordings of one idea in a single answer keep one.
    const repeated = blockedReason(asIdea, [...allIdeas, ...kept.map((other) => ({ text: other.title, topic: other.topic, key: ideaKey(other.topic, other.verb), status: 'open' as const, updatedAt: now.toISOString() }))], now, snoozed);
    const never = blockingRule(rules, [idea.topic, idea.title, idea.why].join(' '));
    // An idea that comes from a conversation goes to the agent of that conversation: one agent's topic is never handed to another.
    const sourceAgent = idea.conversationId === undefined ? undefined : chatAgent.get(idea.conversationId);
    const wrongSource = idea.conversationId === undefined ? undefined
      : sourceAgent === undefined ? 'its source conversation is not one of those shown'
        : sourceAgent !== idea.agentId ? 'its source conversation belongs to ' + nameOf(sourceAgent) + ', not to the agent it names' : undefined;
    if (wrongSource !== undefined) dropped.push(idea.title + ': ' + wrongSource);
    else if (missing.length > 0) dropped.push(idea.title + ': ' + missing.join('; '));
    else if (repeated !== undefined) dropped.push(idea.title + ': repeats an earlier idea (' + repeated + ')');
    else if (never !== undefined) dropped.push(idea.title + ': the owner said never to hear about "' + never.text + '"');
    else if (kept.length >= room) dropped.push(idea.title + ': over the limit');
    else kept.push(apps.length === 0 ? idea : { ...idea, why: idea.why + ' Needs ' + apps.map((app) => app.name).join(' and ') + ' connected.' });
  }
  for (const idea of kept) {
    let prompt = idea.prompt;
    let prepared: Idea['prepared'];
    if (idea.prepared !== undefined) {
      const path = await draftPath(deps, ownerId, date, idea.prepared.title);
      await editHomeFile(deps, { ownerId, agentId: idea.agentId, path }, () => '# ' + idea.prepared?.title + '\n\n' + idea.prepared?.content + '\n');
      prepared = { kind: 'draft', ref: path, label: idea.prepared.title };
      prompt += '\n\n(The prepared draft is in /juno/' + path + '.)';
    }
    const at = new Date().toISOString();
    const row: Idea & { ownerId: string } = {
      id: 'idea-' + String(Date.now()) + '-' + randomUUID().slice(0, 8), ownerId, agentId: idea.agentId, text: idea.title, prompt,
      why: idea.why, action: { agentId: idea.agentId, prompt }, ...(prepared === undefined ? {} : { prepared }),
      topic: idea.topic, key: ideaKey(idea.topic, idea.verb), source: 'daily', status: 'open', createdAt: at, updatedAt: at,
    };
    const created = await store.put('ideas', row);
    await store.emit({ type: 'idea.updated', idea: created });
    saved.push(created);
  }
  for (const reason of dropped) deps.log?.({ ownerId, reason }, 'idea dropped');
  const newest = items[items.length - 1]?.at ?? checkpoint.itemsAt;
  // A notice is the agent's own decision to interrupt: a hard rule it runs against drops it here (the model was told too), and the daily cap is checked now and again when a reply is posted.
  const wakes: WakeEvent[] = [];
  let noticeRoom = await roomOn(store, ownerId, date);
  for (const raw of noticeRaw) {
    const notice = noticeSchema.safeParse(raw);
    if (!notice.success) continue;
    const never = blockingRule(rules, notice.data.text);
    const agent = capable.find(({ agent: candidate }) => candidate.id === chatAgent.get(notice.data.conversationId))?.agent;
    if (never !== undefined) deps.log?.({ ownerId, rule: never.id }, 'daily notice dropped: a never rule covers it');
    else if (noticeRoom < 1 || wakes.length >= MAX_NOTICES) deps.log?.({ ownerId }, 'daily notice dropped: daily cap reached');
    else if (agent === undefined) deps.log?.({ ownerId }, 'daily notice dropped: its source conversation is not one of those shown, or its agent may not reach out');
    else {
      const planned = planSendTime({ now, quiet: dailyCheck.quiet, ...(notice.data.sendAt === undefined ? {} : { sendAt: notice.data.sendAt }), ...(timeZone === undefined ? {} : { timeZone }) });
      if (planned.adjusted !== undefined) deps.log?.({ ownerId, sendAt: notice.data.sendAt, at: planned.at.toISOString(), reason: planned.adjusted }, 'daily notice send time adjusted');
      wakes.push(await noticeWake(store, ownerId, agent, notice.data, date, planned.at, timeZone, now));
      noticeRoom -= 1;
    }
  }
  return { outcome: 'done', saved, dropped, wakes, checkpoint: { ...(newest === undefined ? {} : { itemsAt: newest }), inputHash, date } };
}
