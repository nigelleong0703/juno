/**
 * The "Where you are" context section, generated for each conversation: which kind of chat this is, who reads the agent's replies,
 * what the chat can do, and the rules that follow from who is in it. The core prompt says "the person you're helping"; this section
 * fills in the real name. It is rendered on every build and reaches the model as a note only when its text changes (context-notes.ts).
 *
 * Not here: what an automatic wake or a helper run is (those arrive with their wake text, messages.ts), and the ids and members of
 * the conversation (the Session section). A helper run (child session) gets no section at all.
 */
import { chatCapabilities, MAX_UPLOAD_BYTES, type ActionsPolicy, type ChatCapabilities } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { agentAppSettings, settingFor, usableApps } from '../../modules/apps/agent-apps.js';
import { channelGrants, readsChatHistory, replyOriginOf } from '../../modules/channel-origin.js';
import type { ConnectorCatalog } from '../../modules/mcp/catalog.js';
import { listAll } from '../../modules/memory/util.js';
import { readProfile, type ProfileAudience } from '../../modules/profile/index.js';
import type { HarnessId } from '../../modules/harness/ids/index.js';
import { harnessText } from '../../modules/harness/loader.js';
import { docOwner } from '../execution-owner.js';
import { PLATFORM_NAMES } from './messages.js';
import { ownerSpeakerName } from './social-conversation.js';
import { readVisibleConversation, type SocialContextInput } from './social-context.js';
import { quoteLabel } from './social-format.js';
import { readChannelKind, readString } from './social-read.js';

const MAX_APPS_SHOWN = 12;
const MB = 1024 * 1024;

/** A name or title that came from outside (a profile, a platform) as one short plain line. */
function plain(value: string | undefined, max = 40): string | undefined {
  const text = (value ?? '').replace(/[\p{Cc}<>"`]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return text === '' ? undefined : text;
}

function listOr(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}

/** The person the agent works for, in the forms the sentences need. Without a known name it stays "the person you're helping". */
function ownerForms(name: string | undefined) {
  return {
    who: name ?? "the person you're helping",
    whoFull: name === undefined ? "the person you're helping" : name + " (the person you're helping)",
    whoFullCap: name === undefined ? "The person you're helping" : name + " (the person you're helping)",
    intro: name === undefined ? "the person you're helping" : name + ", the person you're helping",
    onlyReads: name === undefined ? 'Only they read' : 'Only ' + name + ' reads',
    memoryOf: name === undefined ? "The private memory of the person you're helping" : name + "'s private memory",
    poss: name === undefined ? 'their' : name + "'s",
    possCap: name === undefined ? 'Their' : name + "'s",
    them: name ?? 'them',
  };
}
type Owner = ReturnType<typeof ownerForms>;

/**
 * The owner's name: the profile "Name" (a private entry only in a run that serves the owner alone), else the name the platform
 * shows for the owner in a platform chat.
 */
async function ownerName(store: Store, audience: ProfileAudience, conversationId: string, platform: boolean): Promise<string | undefined> {
  const entry = (await readProfile(store, audience.profileOwnerId))?.entries.find((candidate) => candidate.key.trim().toLowerCase() === 'name');
  if (entry !== undefined && (audience.ownerOnly || entry.visibility === 'shared')) return plain(entry.value);
  return platform ? plain(await ownerSpeakerName(store, conversationId)) : undefined;
}

const POLICY_NOTE: Readonly<Record<ActionsPolicy, HarnessId>> = {
  ask: 'where.policy.ask',
  allow: 'where.policy.allow',
  off: 'where.policy.off',
};

/**
 * The apps this agent can use, one line each ("- Name: what it does (what its changes need)"), sorted so the text only changes when
 * the set or a policy does. Only the apps added and turned on for this agent are here; one that is not added, is off for it or has an
 * expired sign-in is not, and the agent learns why through connector_search and connect_request.
 */
async function appLines(store: Store, ownerId: string | undefined, agentId: string, catalog: ConnectorCatalog | undefined): Promise<string[]> {
  if (ownerId === undefined) return [];
  try {
    const rows = (await listAll(store, 'connections')).filter((row) => docOwner(row) === ownerId);
    const settings = await agentAppSettings(store, agentId);
    return [...usableApps(rows, settings)].flatMap(([appId, name]) => {
      const shown = plain(name);
      if (shown === undefined) return [];
      // A web app has no MCP server: it is read through the agent's computer with its how-to skill, and it never changes anything.
      const web = catalog?.web?.(appId);
      const entry = catalog?.get(appId) ?? web;
      // An app the catalog retired (or never had) is no app of the agent's any more, whatever connection rows are left.
      if (catalog !== undefined && entry === undefined && rows.some((row) => row.catalogId === appId)) return [];
      // An app that ships how-to skills says so, with the names skill_read takes (`<app>/<skill>`, the onboarding skill first): the skills are
      // platform skill rows of source `app:<appId>`, readable only while the app is on for the agent (agentd/src/apps/skills.ts).
      const shipped = entry?.skills ?? [];
      const first = entry?.onboardingSkill;
      const names = [...shipped.filter((skill) => skill.name === first), ...shipped.filter((skill) => skill.name !== first)].slice(0, 3).map((skill) => appId + '/' + skill.name);
      const howTo = shipped.length > 0 ? harnessText(web === undefined ? 'where.app.howto_own' : 'where.app.howto_web', { names: names.join(', ') }) : '';
      const policy = web === undefined ? harnessText(POLICY_NOTE[settingFor(settings, appId).actionsPolicy]) : harnessText('where.app.web_policy');
      return [harnessText('where.app.line', { name: shown, description: plain(entry?.description, 160) ?? harnessText('where.app.custom'), policy, howTo })];
    }).sort();
  } catch {
    return [];
  }
}

/** "This chat can: ..." from the capability table, with what it cannot do said in the same breath. */
function capabilityLine(table: ChatCapabilities, opts: { history: boolean; reactions: boolean; readHistory?: boolean }): string {
  // The owner can switch reading earlier messages off for the agent (permission tier `readHistory`): the table then reads as no history.
  const caps = opts.readHistory === false ? { ...table, history: { ...table.history, window: false, onDemand: false } } : table;
  const { ui, files } = caps;
  const sendMb = files.send ? Math.min(files.maxSendMb, MAX_UPLOAD_BYTES / MB) : 0;
  const react = opts.reactions && caps.reactions.mode !== 'none';
  const reactText = caps.reactions.mode === 'limited' ? harnessText('where.can.react_limited', { emoji: (caps.reactions.allowed ?? []).slice(0, 5).join(' ') }) : harnessText('where.can.react');
  const can = [
    ui.choices && ui.fields ? harnessText('where.can.buttons_forms') : ui.choices ? harnessText('where.can.buttons') : ui.fields ? harnessText('where.can.forms') : '',
    react ? reactText : '',
    opts.history && caps.history.window ? harnessText('where.can.window') : '',
    opts.history && caps.history.onDemand ? harnessText('where.can.on_demand') : '',
    sendMb > 0 ? harnessText('where.can.files', { mb: String(sendMb) }) : '',
  ].filter((part) => part !== '');
  const cannot = [ui.choices ? '' : 'buttons', ui.fields ? '' : 'forms', react ? '' : 'reactions', sendMb > 0 ? '' : 'file uploads'].filter((part) => part !== '');
  return harnessText('where.can.line', { can: can.length === 0 ? harnessText('where.can.plain') : can.join(', ') })
    + (cannot.length === 0 ? '' : ' ' + harnessText('where.cannot.line', { things: listOr(cannot) }))
    + (opts.history && !caps.history.onDemand ? ' ' + harnessText(table.history.onDemand ? 'where.history.owner_off' : 'where.history.none') : '')
    + (ui.fields ? '' : ' ' + harnessText('where.fields.plain'));
}

/** What the agent does in any chat the owner shares with other people: their private texts stay out, their words are not the owner's. */
function sharedRules(o: Owner, opts: { toOwner: boolean }): string[] {
  return [
    harnessText('where.shared.memory', { memoryOf: o.memoryOf, them: o.them }),
    ...(opts.toOwner ? [harnessText('where.shared.to_owner', { who: o.who, them: o.them, poss: o.poss })] : []),
    harnessText('where.shared.public', { possCap: o.possCap, poss: o.poss, them: o.them }),
    harnessText('where.shared.words', { who: o.who }),
    harnessText('where.shared.rude'),
  ];
}

/**
 * Whether `react` is one of this chat's core tools: a platform chat (any kind) or the app's direct chat, on a surface that takes
 * reactions; app rooms take none. Read from the conversation alone, so it is the same on every run of it and the tools array it
 * shapes never changes between runs.
 */
export async function chatTakesReactions(store: Store, conversationId: string): Promise<boolean> {
  const conversation = await store.get('conversations', conversationId).catch(() => null);
  if (conversation === null) return false;
  const platform = readChannelKind(conversation);
  if (platform === undefined && readString(conversation, 'kind') !== 'direct') return false;
  return chatCapabilities(platform ?? 'app').reactions.mode !== 'none';
}

/** The chat's name from its stored title ("#general · Discord"), without the platform suffix; undefined when the platform gave none. */
function chatName(title: string | undefined, platform: string): string | undefined {
  const name = plain(title?.endsWith(' · ' + platform) ? title.slice(0, -(' · ' + platform).length) : title, 80);
  return name === undefined || name === 'Group chat' ? undefined : quoteLabel(name);
}

export interface WhereInput extends SocialContextInput {
  audience: ProfileAudience;
  /** A computer is bound to this run, so the agent can say it works on one. */
  hasComputer: boolean;
  /** The connector catalog, for what each app does; absent leaves the apps unexplained. */
  catalog?: ConnectorCatalog;
}

/** The section's text, or '' when there is nothing to say (a helper run, a thread between agents, a conversation this run may not see). */
export async function buildWhereSection(store: Store, input: WhereInput): Promise<string> {
  if (input.wake.some((event) => event.kind === 'child_task')) return '';
  const doc = await readVisibleConversation(store, input);
  const kind = doc === undefined ? undefined : readString(doc, 'kind');
  if (doc === undefined || (kind !== 'direct' && kind !== 'room')) return '';
  // A conversation tied to a platform (a group, a stranger's private chat), else where the latest message came from: the owner's
  // private chats from every platform share one conversation.
  const surface = readChannelKind(doc) ?? replyOriginOf(input.wake)?.kind ?? 'app';
  const platform = surface === 'app' ? undefined : (PLATFORM_NAMES[surface] ?? plain(surface));
  const { audience } = input;
  const o = ownerForms(await ownerName(store, audience, input.conversationId, platform !== undefined));
  const caps = chatCapabilities(surface, await channelGrants(store, replyOriginOf(input.wake)));
  // In the app a reaction goes on the owner's own message in a direct chat; on a platform it goes on the message that woke the run, in any chat.
  const reactions = platform !== undefined || (kind === 'direct' && audience.ownerOnly);
  const lines = [harnessText('where.heading')];

  if (kind === 'room' && platform !== undefined) {
    const name = chatName(readString(doc, 'title'), platform);
    const place = name === undefined ? harnessText('where.group.place_unnamed', { platform }) : harnessText('where.group.place_named', { name, platform });
    lines.push(harnessText('where.group.intro', { place, whoFullCap: o.whoFullCap }));
    lines.push(capabilityLine(caps, { history: true, reactions, readHistory: readsChatHistory(await store.get('agents', input.agentId).catch(() => null)) }));
    lines.push(harnessText('where.group.speak'));
    lines.push(harnessText('where.group.note', { who: o.who }));
    lines.push(...sharedRules(o, { toOwner: true }));
  } else if (kind === 'room') {
    const name = plain(readString(doc, 'title'), 80);
    const lead = name === undefined ? harnessText('where.room.lead_unnamed') : harnessText('where.room.lead_named', { name: quoteLabel(name) });
    lines.push(harnessText('where.room.intro', { lead, who: o.who }));
    lines.push(capabilityLine(caps, { history: false, reactions }));
    lines.push(harnessText('where.room.mention'));
    if (!audience.ownerOnly) lines.push(...sharedRules(o, { toOwner: true }));
  } else if (audience.ownerOnly) {
    lines.push(harnessText('where.private.intro', { intro: o.intro, onPlatform: platform === undefined ? '' : harnessText('where.private.on_platform', { platform }), onlyReads: o.onlyReads }));
    lines.push(capabilityLine(caps, { history: false, reactions }));
    const apps = await appLines(store, audience.profileOwnerId, input.agentId, input.catalog);
    lines.push(harnessText('where.private.can', { them: o.them, computer: input.hasComputer ? harnessText('where.private.computer') + ' ' : '', apps: apps.length === 0 ? '' : harnessText('where.private.apps') }));
    if (apps.length > 0) lines.push(...apps.slice(0, MAX_APPS_SHOWN), ...(apps.length > MAX_APPS_SHOWN ? [harnessText('where.private.more', { count: String(apps.length - MAX_APPS_SHOWN) })] : []));
  } else {
    lines.push(harnessText('where.other.intro', { platform: platform ?? harnessText('where.platform.app'), whoFull: o.whoFull }));
    lines.push(capabilityLine(caps, { history: false, reactions }));
    lines.push(...sharedRules(o, { toOwner: false }));
  }
  // Batch 5b: the owner's calendar is answered as busy times only, so a member may be told free or busy (never what or where).
  if (!audience.ownerOnly) lines.push(harnessText('where.calendar', { who: o.who }));
  return lines.join('\n');
}
