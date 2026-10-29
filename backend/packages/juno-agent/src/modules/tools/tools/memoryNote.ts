// memory_note: the agent's way to remember something about the user or a person in their life (BACKEND §5.3). It writes one active
// memory item (BACKEND §5.4, §9.5) with the writing agent as its author, worded short and self-contained (no subject for the person being
// helped, a name for anyone else), given a topic, and labelled with where it was said and who may hear it. A note that an active item of the
// same person and audience already says updates that item instead. It is the agent's own inference: it is never taken as something the
// user said. It shows in the views marked with its author. A sub-task never writes notes.
import { z } from 'zod';
import type { AccountPlatform } from '@agent-desktop/memory-graph/identity';
import { ITEM_TOPICS, type ItemFile } from '@agent-desktop/memory-graph/memory';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { chatWorkspace } from '../../groups/note.js';
import type { MemoryPort } from '../../memory/port.js';
import { noteKindOf, personFor, PERSONAL_PRONOUN, placeOf } from '../../memory/notes.js';
import { ownerNameOf } from '../../memory/owner.js';
import { topicSchema } from '../../memory/wording.js';
import { readProfile } from '../../profile/index.js';
import type { ComputerClientProvider } from '../computer/client.js';

export const NOTE_KINDS = ['fact', 'circumstance', 'preference', 'experience', 'commitment'] as const;
type NoteKind = (typeof NOTE_KINDS)[number];
const MAX_TEXT_CHARS = 300;
const MAX_ABOUT_CHARS = 80;

const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\r\n]/.test(value), 'must be one line');
const schema = z.object({
  about: oneLine(MAX_ABOUT_CHARS),
  kind: z.enum(NOTE_KINDS),
  /** A topic the model invented is dropped, not the note. */
  topic: topicSchema.optional().catch(undefined),
  text: oneLine(MAX_TEXT_CHARS),
  private: z.boolean().optional(),
  sensitive: z.boolean().optional(),
});
/** `about` values that mean the owner ("user" is what the tool asks for). */
const ABOUT_OWNER = /^(?:the |my )?(?:user|owner)$/i;

/** The owner's profile "Name" as lowercase: the whole value and its first word ("Jane Tan" gives "jane tan" and "jane"). */
async function ownerNames(ctx: ToolContext): Promise<string[]> {
  const name = (await readProfile(ctx.store, ctx.ownerId))?.entries.find((entry) => entry.key.trim().toLowerCase() === 'name')?.value.trim().toLowerCase();
  if (name === undefined || name === '') return [];
  return [name, name.split(/\s+/)[0] ?? name];
}

/** The item file a note goes into when it is not about one other person: the sheet, or the bank file of its kind. */
const FILE_OF: Record<NoteKind, ItemFile> = {
  fact: 'memory',
  commitment: 'memory',
  circumstance: 'bank:circumstances',
  preference: 'bank:preferences',
  experience: 'bank:experiences',
};

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });

/**
 * Who is speaking in this run, as the wake recorded it: the speaker's person and account (set at ingress), or, for the owner's own
 * words, the owner's person. The account is looked up on its platform when the wake only names the speaker's platform id.
 */
async function speakerOf(ctx: ToolContext, memory: MemoryPort, ownerPersonId: string | undefined): Promise<{ personId?: string; accountId?: string }> {
  const fromPayload = (key: string): string | undefined => {
    const value = ctx.wake.payload[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const personId = fromPayload('personId') ?? (ctx.wake.trusted ? ownerPersonId : undefined);
  const platform = fromPayload('channelKind');
  const externalId = fromPayload('speakerId');
  const channelId = fromPayload('channelId');
  let accountId = fromPayload('accountId');
  if (accountId === undefined && platform !== undefined && externalId !== undefined) {
    const workspace = platform === 'slack' && channelId !== undefined ? await chatWorkspace(ctx.store, ctx.ownerId, { kind: platform, channelId }) : '';
    accountId = (await memory.people.findAccount(ctx.ownerId, { platform: platform as AccountPlatform, workspace, externalId }).catch(() => undefined))?.id;
  }
  return { ...(personId === undefined ? {} : { personId }), ...(accountId === undefined ? {} : { accountId }) };
}

export function createMemoryNoteTool(opts: { memory?: MemoryPort; computer?: ComputerClientProvider }): Tool {
  return {
    name: 'memory_note',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        about: { type: 'string', description: '' },
        kind: { type: 'string', enum: [...NOTE_KINDS], description: '' },
        topic: { type: 'string', enum: [...ITEM_TOPICS], description: '' },
        text: { type: 'string', description: '' },
        private: { type: 'boolean', description: '' },
        sensitive: { type: 'boolean', description: '' },
      },
      required: ['about', 'kind', 'text'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.wake.kind === 'child_task') return result('a sub-task cannot write memory notes; report what you learned to the agent that started you.', true);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return result(`"about", "kind" and "text" are required; "text" is one line of at most ${String(MAX_TEXT_CHARS)} characters.`, true);
      const { about, kind, topic, text, sensitive, private: hidden } = parsed.data;
      // Only the owner's own words (a trusted wake) are noted about the owner; what someone else says about them, or what a stranger claims, is not memory.
      const names = await ownerNames(ctx);
      const aboutOwner = ABOUT_OWNER.test(about) || names.includes(about.toLowerCase());
      if (!ctx.wake.trusted && aboutOwner) return result("Only your owner's own words can be noted about them.", true);
      const pronoun = PERSONAL_PRONOUN.exec(text)?.[0];
      const author = (await ctx.store.get('agents', ctx.agentId))?.name ?? 'agent';
      if (pronoun !== undefined) {
        return result(`the note says "${pronoun}", which only means something to whoever wrote it. Rewrite it with no subject for the person you are helping and a name for anyone else, and name each agent by name and id, e.g. "Wants ${author} (${ctx.agentId}) as a diet planner".`, true);
      }
      const memory = opts.memory;
      if (memory === undefined) return result('memory notes are unavailable: this deployment has no database for memory.', true);
      // The owner's own person always exists (BACKEND §9.5): a note about the owner points at it, made here if the backfill has not run.
      const ownerPerson = await memory.people.ensureOwner(ctx.ownerId, await ownerNameOf(ctx.store, ctx.ownerId));
      const people = await memory.people.list(ctx.ownerId);
      let aboutPersonId: string | null = aboutOwner ? ownerPerson.id : null;
      if (!aboutOwner) {
        const known = personFor(about, people);
        const sameName = people.filter((person) => person.name.trim().toLowerCase() === about.toLowerCase());
        // The owner's word makes the person: a name nobody has yet gets a page of its own (as the hourly job does).
        if (known !== undefined) aboutPersonId = known.id;
        else if (ctx.wake.trusted && sameName.length === 0 && !/^per_/i.test(about)) aboutPersonId = (await memory.people.createPerson(ctx.ownerId, about)).id;
      }
      const file: ItemFile = !aboutOwner && aboutPersonId !== null ? 'person' : FILE_OF[kind];
      const place = await placeOf(ctx.store, ctx.ownerId, ctx.conversationId);
      const speaker = await speakerOf(ctx, memory, ownerPerson.id);
      const noted = await memory.note(ctx.ownerId, {
        text,
        kind: noteKindOf(kind),
        file,
        ...(topic === undefined ? {} : { topic }),
        aboutPersonId,
        saidByPersonId: speaker.personId ?? null,
        saidByAccountId: speaker.accountId ?? null,
        saidByAgentId: ctx.agentId,
        saidIn: place.saidIn,
        audience: hidden === true ? 'owner' : place.audience,
        sensitive: sensitive === true,
        status: 'active',
      });
      if (noted === null) return result('the note could not be stored; try again.', true);
      // The note is in the views at once (marked with its author), so the files the context reads carry it from the next read on.
      const home = opts.computer?.()?.home;
      await memory.renderViews({ ownerId: ctx.ownerId, agentId: ctx.agentId, ...(home === undefined ? {} : { home }) });
      return result(`${noted.updated ? 'Already remembered, updated' : 'Noted'} (${noted.item.id}): ${text}`);
    },
  };
}
