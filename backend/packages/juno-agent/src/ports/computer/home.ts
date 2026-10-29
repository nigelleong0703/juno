/**
 * The user's home directory on their computer (`/juno`, BACKEND §5.2), as the platform sees it. Needs only the VM binding:
 * no screen, and a paused computer is resumed first. Paths are relative to `/juno` (see modules/home/paths.ts).
 */
import { z } from 'zod';

export interface HomeFileStat {
  path: string;
  /** sha256 hex of the file's bytes. */
  hash: string;
  /** Last modification, epoch seconds. */
  mtime: number;
}

/** A platform skill shipped in the image (`/opt/juno/skills/<name>/SKILL.md`), as its frontmatter names it. */
export interface PlatformSkill {
  name: string;
  description: string;
  /** Absolute path of its SKILL.md in the computer. */
  path: string;
}

export interface HomeSnapshot {
  /** The computer carries the `.juno-sync` marker; false means a new or reset computer (§5.2 rule 2). */
  synced: boolean;
  /** Stats of USER.md, PROACTIVE_PREFERENCES.md, MEMORY.md, ALIGNMENT_SYNTHESIS.md, the agent's four files and its `skills/`, and everything under `memory/`, `dreams/`, `people/`, `groups/`, `self_improvement/` and `docs/`. */
  files: HomeFileStat[];
  /** The platform skills the image carries; empty or absent when the computer has none. */
  platformSkills?: PlatformSkill[];
}

export interface HomeContent {
  content: string;
  hash: string;
}

/** Documents whose text the computer can extract with its platform skill tools. */
export type HomeTextFormat = 'pdf' | 'docx';

export interface HomeExtractedText {
  text: string;
  /** The computer cut the text at its size cap. */
  truncated: boolean;
}

export interface HomeComputer {
  /** One call listing everything the sync needs for `agentId`'s home (and the shared files). */
  snapshot(agentId: string, signal: AbortSignal): Promise<HomeSnapshot>;
  /** `null` when the file does not exist. `agentId` only resolves whose computer when the caller has no request owner. */
  read(agentId: string | undefined, path: string, signal: AbortSignal): Promise<HomeContent | null>;
  /** Writes `content` (creating parents); with `expectedHash` the file must still have that hash, else a `home_conflict` error. */
  write(agentId: string | undefined, path: string, content: string, expectedHash: string | undefined, signal: AbortSignal): Promise<{ hash: string }>;
  /** Puts uploaded bytes at `path` (a binary file the agents may read but not change); a file with the same bytes is left as is (`written: false`). */
  putFile(agentId: string | undefined, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<{ hash: string; written: boolean }>;
  /** The text of a PDF or DOCX already in the home, extracted on the computer. Fails when the tool cannot read it. */
  extractText(agentId: string | undefined, path: string, format: HomeTextFormat, signal: AbortSignal): Promise<HomeExtractedText>;
  delete(agentId: string | undefined, path: string, expectedHash: string | undefined, signal: AbortSignal): Promise<void>;
  /** Creates the agent's daily log (an empty file the agent user may append to) when it is missing; an existing file is left alone. */
  ensure(agentId: string | undefined, path: string, signal: AbortSignal): Promise<void>;
}

export const homeSnapshotSchema = z.object({
  synced: z.boolean(),
  files: z.array(z.object({ path: z.string().min(1), hash: z.string().min(1), mtime: z.number() })),
  platformSkills: z.array(z.object({ name: z.string().min(1), description: z.string(), path: z.string().min(1) })).optional(),
});

export const homePutResultSchema = z.object({ hash: z.string().min(1), written: z.boolean() });
export const homeExtractedTextSchema = z.object({ text: z.string(), truncated: z.boolean() });
export const homeContentSchema = z.object({ content: z.string(), hash: z.string().min(1) });
