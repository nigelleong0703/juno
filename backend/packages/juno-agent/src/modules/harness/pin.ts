/**
 * The harness version a session reads (BACKEND §11.2): the one its frozen system row names (contextMeta.harnessVersion), resolved through
 * the pins, else the active version (no frozen row yet, or no pins: the in-memory store). buildContext and the wake texts share it, so a
 * wake written into a pinned session reads the same version as that session's context.
 */
import type { Store, TranscriptEntry } from '../../contracts/index.js';
import { findSystemEntry, metaOf } from '../../execution/brain/context-notes.js';
import { activeHarnessVersion, withHarnessVersion, type HarnessVersion } from './loader.js';
import type { HarnessPins } from './store.js';

export async function sessionHarnessVersion(pins: HarnessPins | undefined, entries: TranscriptEntry[]): Promise<HarnessVersion> {
  if (pins === undefined) return activeHarnessVersion();
  const system = findSystemEntry(entries);
  return pins.resolve(system === undefined ? undefined : metaOf(system.message)?.harnessVersion);
}

/**
 * Compaction rebuilds the prefix, so its cache is lost then anyway: this is the moment the session leaves an old pin. The frozen system
 * row keeps its text and names the active version; the next build writes the rules under it (the prompt-hash rewrite) and old pins die out.
 * Returns the rewritten row, or undefined when there is no system row or it already names the active version.
 */
export async function repinSystemRow(store: Store, entries: TranscriptEntry[]): Promise<TranscriptEntry | undefined> {
  const system = findSystemEntry(entries);
  const activeId = activeHarnessVersion().id;
  if (system === undefined || metaOf(system.message)?.harnessVersion === activeId) return undefined;
  const rewritten: TranscriptEntry = { ...system, message: { ...system.message, contextMeta: { ...metaOf(system.message), harnessVersion: activeId } } };
  await store.put('transcripts', rewritten);
  return rewritten;
}

/** Run `fn` with every harnessText read inside it on the session's pinned version. */
export async function withSessionHarness<T>(pins: HarnessPins | undefined, entries: TranscriptEntry[], fn: () => T): Promise<T> {
  return withHarnessVersion(await sessionHarnessVersion(pins, entries), fn);
}
