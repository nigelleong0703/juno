/**
 * The group note's source and writer (BACKEND §5.7.9). The chat digest asks for a platform group's About when the group has none or it is
 * a week old: `groupNoteSource` reads what was said lately (the platform's history when the chat can give it and the owner allows it,
 * otherwise the messages this agent received), and `writeGroupAbout` writes the About section the model answered with, keeping the
 * owner's rules. Only the note is stored: no message is kept. The messages are other people's words, passed to the model as untrusted data.
 */
import { chatCapabilities, type Agent, type ChannelOrigin } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { channelGrants, readsChatHistory } from '../channel-origin.js';
import type { HomeDeps } from '../home/service.js';
import { editHomeFile } from '../memory/files.js';
import type { ChannelPort } from '../tools/tools/channelHistory.js';
import { noteAuthorSuffix } from '../home/paths.js';
import { ABOUT_MAX_CHARS, REFRESH_AFTER_DAYS, groupNoteTitle, noteDate, parseNote, plainBlock, renderNote, withAbout } from './note.js';

/** What one read looks at: the newest this many messages inside this many days. */
const MESSAGES = 200;
const WINDOW_DAYS = REFRESH_AFTER_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Messages asked of the platform per call (Feishu gives at most 50, the others more), and calls per read: a short page is the end of the chat. */
const PAGE = 50;
const PAGES = MESSAGES / PAGE;
/** A first note needs this many messages to say anything; a refresh needs one. */
const FIRST_MIN_LINES = 5;
const LINE_MAX_CHARS = 400;

export interface GroupNoteSourceTarget {
  ownerId: string;
  agentId: string;
  conversationId: string;
  /** The platform chat of the wake, when there is one: the history is read from it. */
  origin?: ChannelOrigin;
}

/** `ok`: the lines, oldest first, labelled; `skipped`: too little to say yet; `failed`: the platform did not answer. */
export type GroupNoteSource = { status: 'ok'; lines: string[] } | { status: 'skipped' } | { status: 'failed' };

type Gathered = { status: 'ok'; lines: string[] } | { status: 'failed' };

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').replace(/<(\/?)untrusted/gi, '‹$1untrusted').trim().slice(0, LINE_MAX_CHARS);

/** The time a history line starts with (`2026-10-22T10:00:00Z · ...`), or undefined for "unknown time". */
function lineTime(line: string): number | undefined {
  const at = Date.parse(line.slice(0, line.indexOf(' · ')));
  return Number.isNaN(at) ? undefined : at;
}

/** A line the agent wrote itself ("you (Name)" on a platform, "you" in the stored conversation): it says nothing about the group. */
const isOwnLine = (line: string): boolean => /^(?:\S+|unknown time) · you(?: \(|:)/.test(line);

/** The platform's history, newest pages first, as labelled lines oldest first; `unavailable` when the chat gives none here. */
async function readPlatformHistory(channels: ChannelPort | undefined, target: GroupNoteSourceTarget & { origin: ChannelOrigin }, since: number): Promise<Gathered | 'unavailable'> {
  if (channels === undefined) return 'unavailable';
  const lines: string[] = [];
  let beforeAt: string | undefined;
  for (let page = 0; page < PAGES && lines.length < MESSAGES; page += 1) {
    const got = await channels.history({ ownerId: target.ownerId, agentId: target.agentId, origin: target.origin, limit: PAGE, ...(beforeAt === undefined ? {} : { beforeAt }) });
    if (got.status === 'unsupported' || got.status === 'skipped') {
      if (page === 0) return 'unavailable';
      break;
    }
    if (got.status === 'failed') {
      if (page === 0) return { status: 'failed' };
      break;
    }
    const { lines: older, capped } = got.value;
    if (older.length === 0) break;
    lines.unshift(...older);
    const oldest = lineTime(older[0] ?? '');
    if (capped || older.length < PAGE || oldest === undefined || oldest < since) break;
    beforeAt = new Date(oldest).toISOString();
  }
  const inWindow = lines.filter((line) => (lineTime(line) ?? since) >= since);
  return { status: 'ok', lines: [...new Set(inWindow)].slice(-MESSAGES).map(oneLine) };
}

/** The messages this agent received in the conversation (and its own replies), as the same labelled lines. */
async function readStoredMessages(store: Store, conversationId: string, since: number): Promise<string[]> {
  const page = await store.list('items', { where: { conversationId }, orderBy: 'at', order: 'desc', limit: MESSAGES });
  const lines: string[] = [];
  for (const item of page.items) {
    if (Date.parse(item.at) < since) break;
    const at = new Date(item.at).toISOString().slice(0, 19) + 'Z';
    if (item.type === 'user_message') {
      const sender = item.channelSender;
      const who = sender?.role === 'owner' ? 'your owner' : sender?.externalId.startsWith('agent:') === true ? 'another agent of your owner' : 'not your owner';
      lines.push(oneLine(at + ' · ' + (sender?.name ?? 'someone') + ' (' + who + '): ' + item.text));
    } else if (item.type === 'agent_message') {
      lines.push(oneLine(at + ' · you: ' + item.markdown));
    }
  }
  return lines.reverse();
}

/**
 * The lines the note is written from: the last week of the chat. A first About needs enough lines from other people; a refresh needs one.
 * `skipped` when there is too little to say; `failed` when the platform did not answer (the note then waits for the next digest).
 */
export async function groupNoteSource(deps: { store: Store; channels?: ChannelPort }, input: GroupNoteSourceTarget & { agent: Agent; first: boolean; now: Date }): Promise<GroupNoteSource> {
  const since = input.now.getTime() - WINDOW_DAYS * DAY_MS;
  const origin = input.origin;
  const allowed = origin !== undefined && readsChatHistory(input.agent) && chatCapabilities(origin.kind, await channelGrants(deps.store, origin)).history.onDemand;
  const read = allowed && origin !== undefined ? await readPlatformHistory(deps.channels, { ...input, origin }, since) : 'unavailable';
  if (read !== 'unavailable' && read.status === 'failed') return { status: 'failed' };
  const lines = read === 'unavailable' ? await readStoredMessages(deps.store, input.conversationId, since) : read.lines;
  if (lines.filter((candidate) => !isOwnLine(candidate)).length < (input.first ? FIRST_MIN_LINES : 1)) return { status: 'skipped' };
  return { status: 'ok', lines };
}

/**
 * Writes the About section from the model's text: plain lines, each with its author ("(noted by <agent>, <id>)"), replacing the old About
 * and keeping every other section (the owner's rules included). Returns whether the file was written.
 */
export async function writeGroupAbout(deps: HomeDeps, input: { ownerId: string; agentId: string; agent: Agent; conversation: object; path: string; about: string; now: Date }): Promise<boolean> {
  const plain = plainBlock(input.about, ABOUT_MAX_CHARS);
  if (plain === '') return false;
  const text = plain.split('\n').map((line) => line + noteAuthorSuffix(input.agent.name, input.agentId)).join('\n');
  return editHomeFile(deps, { ownerId: input.ownerId, agentId: input.agentId, path: input.path }, (content) => {
    const doc = parseNote(content);
    return renderNote(withAbout({ ...doc, title: doc.title === '' ? groupNoteTitle(input.conversation) : doc.title }, text, noteDate(input.now)));
  });
}
