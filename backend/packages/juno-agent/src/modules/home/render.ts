/**
 * The context sections built from the agent's home (BACKEND §5.3). Pure: they read mirror rows, which the sync has just
 * made equal to the computer, and produce the texts `buildContext` places in the system message and the notes.
 */
import { replyStyleFor } from '@agent-desktop/public-contracts';
import { z } from 'zod';
import type { AgentHomeRow } from '../../contracts/storage.js';
import { ALIGNMENT_FILE, AGENT_USER_FILES, USER_FILE, agentFilePath } from './paths.js';

/** What `buildContext` reads from the home: trimmed texts, journaled with the context so a step can reuse them. */
export interface HomeView {
  persona: string;
  principles: string;
  instructions: string;
  toolNotes: string;
  /** The `## When to reach out` part of AGENTS.md. */
  reachOut: string;
  aboutUser: string;
  /** ALIGNMENT_SYNTHESIS.md: the shared part plus this agent's own `## <name>（<agentId>）` section. */
  alignment: string;
  /** Today's daily log of this agent (home-relative), created for it at the sync; '' when the computer is not reachable. */
  dailyLog: string;
  /** Highest transcript seq when this was built; later file-changing tool calls make it stale. */
  seq: number;
}

export const homeViewSchema = z.object({
  persona: z.string(), principles: z.string(), instructions: z.string(), toolNotes: z.string(), reachOut: z.string(),
  aboutUser: z.string(), alignment: z.string(), dailyLog: z.string().default(''), seq: z.number(),
});

export const EMPTY_HOME_VIEW: HomeView = { persona: '', principles: '', instructions: '', toolNotes: '', reachOut: '', aboutUser: '', alignment: '', dailyLog: '', seq: -1 };

const REACH_OUT_HEADING = /^##[ \t]+When to reach out[ \t]*$/im;

/** AGENTS.md is the working instructions; its `## When to reach out` section is split off for the reach-out part. */
export function splitAgentsFile(text: string): { instructions: string; reachOut: string } {
  const start = REACH_OUT_HEADING.exec(text);
  if (start === null) return { instructions: text.trim(), reachOut: '' };
  const after = text.slice(start.index + start[0].length);
  const next = /^##[ \t]/m.exec(after);
  const section = next === null ? after : after.slice(0, next.index);
  const rest = text.slice(0, start.index) + (next === null ? '' : after.slice(next.index));
  return { instructions: rest.trim(), reachOut: section.trim() };
}

/** AGENTS.md text from the two old fields (creation and migration). */
export function joinAgentsFile(instructions: string, reachOut: string): string {
  return [instructions.trim(), reachOut.trim().length === 0 ? '' : '## When to reach out\n' + reachOut.trim()].filter((part) => part.length > 0).join('\n\n');
}

/** The synthesis for one agent: the shared part and its own section (`@agent-desktop/public-contracts` reply-style, which the web reads too). */
export const alignmentFor = replyStyleFor;

/** The view for one agent from its mirror rows. The memory items are read from the database, not from the files (memory/section.ts). */
export function renderHomeView(rows: ReadonlyMap<string, AgentHomeRow>, agentId: string, seq: number, dailyLog = ''): HomeView {
  const text = (path: string): string => rows.get(path)?.content.trim() ?? '';
  const [identity, soul, agents, tools] = AGENT_USER_FILES.map((file) => text(agentFilePath(agentId, file)));
  const { instructions, reachOut } = splitAgentsFile(agents ?? '');
  return {
    persona: identity ?? '',
    principles: soul ?? '',
    instructions,
    toolNotes: tools ?? '',
    reachOut,
    aboutUser: text(USER_FILE),
    alignment: alignmentFor(text(ALIGNMENT_FILE), agentId),
    dailyLog,
    seq,
  };
}
