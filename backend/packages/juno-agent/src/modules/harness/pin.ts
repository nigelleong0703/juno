/**
 * The harness version a session reads (BACKEND §11.2): the one its frozen system row names (contextMeta.harnessVersion), resolved through
 * the pins, else the active version (no frozen row yet, or no pins: the in-memory store). buildContext and the wake texts share it, so a
 * wake written into a pinned session reads the same version as that session's context.
 */
import type { TranscriptEntry } from '../../contracts/index.js';
import { findSystemEntry, metaOf } from '../../execution/brain/context-notes.js';
import { activeHarnessVersion, withHarnessVersion, type HarnessVersion } from './loader.js';
import type { HarnessPins } from './store.js';

export async function sessionHarnessVersion(pins: HarnessPins | undefined, entries: TranscriptEntry[]): Promise<HarnessVersion> {
  if (pins === undefined) return activeHarnessVersion();
  const system = findSystemEntry(entries);
  return pins.resolve(system === undefined ? undefined : metaOf(system.message)?.harnessVersion);
}

/** Run `fn` with every harnessText read inside it on the session's pinned version. */
export async function withSessionHarness<T>(pins: HarnessPins | undefined, entries: TranscriptEntry[], fn: () => T): Promise<T> {
  return withHarnessVersion(await sessionHarnessVersion(pins, entries), fn);
}
