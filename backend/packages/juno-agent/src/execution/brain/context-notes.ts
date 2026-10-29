/**
 * Append-only model context: a frozen system row plus context notes.
 *
 * The prompt prefix is never edited. The system message is written once per session as a
 * transcript row and replayed byte for byte. Everything that changes during a session (date,
 * tasks, memory, goals, skills, computer, room history, session roster, edited agent profile) is a
 * named *section*. Each section keeps a hash of the text last delivered to the model; when the
 * current text differs, a short `<context_update>` user row carrying only the changed sections is
 * appended to the end of the history (after any tool results, so call/result pairs stay intact).
 * The hashes live on the rows themselves (`contextMeta`), so the delivered baseline is whatever the
 * projected transcript already shows: replay is deterministic and compaction resets the baseline
 * naturally (the next build re-sends the sections it can no longer see).
 */
import { createHash } from 'node:crypto';
import type { Message, SystemMessage, UserMessage } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { TranscriptEntry } from '../../contracts/index.js';
import { PHONE_SECTION_GONE } from '../phone.js';
import { TOOL_SCOPES, type ToolScope } from '../../modules/tools/scope.js';
import { harnessText } from '../../modules/harness/loader.js';
import type { HarnessId } from '../../modules/harness/ids/index.js';

/** Fixed delivery order of the sections inside one note. */
export const SECTION_ORDER = ['profile', 'where', 'groupNote', 'date', 'session', 'team', 'room', 'memory', 'goals', 'skills', 'tasks', 'userDetails', 'computerFacts', 'computer', 'phone', 'artifacts'] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

/** The harness unit that says what a section says once it becomes empty after having been delivered (the phone one lives in phone.ts). */
const EMPTY_TEXT_IDS: Record<Exclude<SectionId, 'phone'>, HarnessId> = {
  profile: 'context.empty_profile',
  where: 'context.empty_where',
  groupNote: 'context.empty_group_note',
  date: 'context.empty_date',
  session: 'context.empty_session',
  team: 'context.empty_team',
  room: 'context.empty_room',
  memory: 'context.empty_memory',
  goals: 'context.empty_goals',
  skills: 'context.empty_skills',
  tasks: 'context.empty_tasks',
  userDetails: 'context.empty_user_details',
  computerFacts: 'context.empty_computer_facts',
  computer: 'context.empty_computer',
  artifacts: 'context.empty_artifacts',
};

/** What a section says once it becomes empty after having been delivered. */
function emptyText(id: SectionId): string {
  return id === 'phone' ? PHONE_SECTION_GONE : harnessText(EMPTY_TEXT_IDS[id]);
}

export type SectionTexts = Record<SectionId, string>;

/**
 * The section hashes a stored row delivered. Rows written before a section was removed (the old `onboarding` one) still carry its
 * key: it is dropped here, so one stale key never makes the whole meta unreadable (which would lose the row's other hashes and its tool order).
 */
const sectionHashes = z.record(z.string(), z.string()).transform((stored): Partial<Record<SectionId, string>> => {
  const known: Partial<Record<SectionId, string>> = {};
  for (const id of SECTION_ORDER) {
    const hash = stored[id];
    if (hash !== undefined) known[id] = hash;
  }
  return known;
});

/** Persisted next to a context row: the section hashes it delivered and the session's tool order. */
/** Validates the meta read back from a stored row (journaled data is untrusted until parsed). */
const contextMetaSchema = z.object({
  sections: sectionHashes.optional(),
  toolOrder: z.array(z.string()).optional(),
  /** Who was present when the conversation started (batch 5b): the tools offered to it, frozen with the row. A damaged value reads as absent. */
  toolScope: z.enum(TOOL_SCOPES).optional().catch(undefined),
  /** The SYSTEM_PROMPT version the frozen row was written with: a different one rewrites it once (see context.ts). */
  promptHash: z.string().optional(),
  /** The harness version the session is pinned to (BACKEND §11.2): every later turn reads its units, so the prefix never changes. */
  harnessVersion: z.string().optional(),
  /** The memory item ids a note delivered as "Memory relevant to this message" (batch 5a): never delivered twice in a session. */
  items: z.array(z.string()).optional(),
});

export interface ContextMeta {
  sections?: Partial<Record<SectionId, string>>;
  toolOrder?: string[];
  toolScope?: ToolScope;
  promptHash?: string;
  harnessVersion?: string;
  items?: string[];
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function metaOf(message: Record<string, unknown>): ContextMeta | undefined {
  const parsed = contextMetaSchema.safeParse(message['contextMeta']);
  return parsed.success ? parsed.data : undefined;
}

export function isSystemEntry(entry: TranscriptEntry): boolean {
  return entry.message['role'] === 'system';
}

/** The session's frozen system row (the lowest-seq system row), or undefined before the first build. */
export function findSystemEntry(entries: TranscriptEntry[]): TranscriptEntry | undefined {
  return entries.find(isSystemEntry);
}

/** The last delivered hash per section: the system row first, then every projected row in order. */
export function deliveredHashes(system: TranscriptEntry | undefined, projected: TranscriptEntry[]): Partial<Record<SectionId, string>> {
  const delivered: Partial<Record<SectionId, string>> = {};
  for (const entry of system === undefined ? projected : [system, ...projected]) {
    const sections = metaOf(entry.message)?.sections;
    if (sections === undefined) continue;
    for (const id of SECTION_ORDER) {
      const hash = sections[id];
      if (hash !== undefined) delivered[id] = hash;
    }
  }
  return delivered;
}

export interface SectionChanges {
  /** Rendered text per changed section, in SECTION_ORDER. */
  texts: string[];
  /** The new hash per changed section (an emptied section records the hash of ''). */
  hashes: Partial<Record<SectionId, string>>;
}

/** Sections whose current text differs from what the model last saw. Nothing delivered and nothing now = no change. */
export function diffSections(current: SectionTexts, delivered: Partial<Record<SectionId, string>>): SectionChanges {
  const texts: string[] = [];
  const hashes: Partial<Record<SectionId, string>> = {};
  for (const id of SECTION_ORDER) {
    const text = current[id];
    const hash = hashText(text);
    const seen = delivered[id];
    if (seen === hash) continue;
    if (seen === undefined && text.length === 0) continue;
    texts.push(text.length > 0 ? text : emptyText(id));
    hashes[id] = hash;
  }
  return { texts, hashes };
}

/**
 * Appended once to a chat's history (as its own paragraph of a note) when the frozen system row was rewritten because the rules
 * changed: older messages were written under the previous rules and may still say something else.
 */
export function rulesUpdatedNote(): string {
  return harnessText('context.rules_updated');
}

/** The user-visible note: an optional run-start line, then the changed sections. */
export function renderNote(runStart: string | undefined, texts: string[]): string {
  const body = [...(runStart === undefined || runStart.length === 0 ? [] : [runStart]), ...texts].join('\n\n');
  return '<context_update>\n' + body + '\n</context_update>';
}

/** True while the projected tail ends in an assistant tool call that has no result row yet. */
export function hasPendingToolCall(rows: TranscriptEntry[]): boolean {
  const answered = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const message = rows[index]?.message;
    if (message === undefined) continue;
    if (message['role'] === 'toolResult' && typeof message['toolCallId'] === 'string') answered.add(message['toolCallId']);
    if (message['role'] === 'assistant') {
      const content = message['content'];
      if (!Array.isArray(content)) return false;
      return content.some((block: unknown) => {
        if (typeof block !== 'object' || block === null) return false;
        const id: unknown = Reflect.get(block, 'id');
        return Reflect.get(block, 'type') === 'toolCall' && typeof id === 'string' && !answered.has(id);
      });
    }
  }
  return false;
}

/** The memory item ids every context note of this session has delivered (their `items` meta), for skipping them next time. */
export function deliveredItemIds(entries: TranscriptEntry[]): Set<string> {
  const delivered = new Set<string>();
  for (const entry of entries) for (const id of metaOf(entry.message)?.items ?? []) delivered.add(id);
  return delivered;
}

/** A context row as a pi-ai user message carrying the section hashes (and the memory items it delivered, if any). */
export function noteMessage(text: string, hashes: Partial<Record<SectionId, string>>, items: readonly string[] = []): Message {
  const meta: ContextMeta = { sections: hashes, ...(items.length === 0 ? {} : { items: [...items] }) };
  const message: UserMessage & { contextMeta: ContextMeta } = { role: 'user', content: text, timestamp: Date.now(), contextMeta: meta };
  return message;
}

/** The frozen system message plus the profile hash it delivers (and the tool order, once known). */
export function systemMessage(text: string, profileHash: string, toolOrder: string[] | undefined, promptHash?: string, toolScope?: ToolScope, harnessVersion?: string): Message {
  const meta: ContextMeta = {
    sections: { profile: profileHash }, ...(toolOrder === undefined ? {} : { toolOrder }), ...(promptHash === undefined ? {} : { promptHash }),
    ...(toolScope === undefined ? {} : { toolScope }), ...(harnessVersion === undefined ? {} : { harnessVersion }),
  };
  const message: SystemMessage & { contextMeta: ContextMeta } = { role: 'system', content: text, timestamp: Date.now(), contextMeta: meta };
  return message;
}
