/**
 * Every harness unit the code reads, by id (H1a, BACKEND §11.2). Each owner group has its own file so parallel edits never collide.
 * The loader checks at boot that the seed directory holds exactly these ids (a missing or extra one fails startup).
 */
import { FROZEN_IDS } from './frozen.js';
import { JOB_IDS } from './jobs.js';
import { NOTE_IDS } from './notes.js';
import { CONTEXT_NOTE_IDS } from './notes-context.js';
import { WAKE_IDS } from './wake.js';

export const HARNESS_IDS: readonly string[] = [...FROZEN_IDS, ...NOTE_IDS, ...CONTEXT_NOTE_IDS, ...WAKE_IDS, ...JOB_IDS];

export type HarnessId =
  | (typeof FROZEN_IDS)[number]
  | (typeof NOTE_IDS)[number]
  | (typeof CONTEXT_NOTE_IDS)[number]
  | (typeof WAKE_IDS)[number]
  | (typeof JOB_IDS)[number];
