/**
 * How an agent posts to the owner's Feed (BACKEND §10.10).
 *
 * Single source: the `tool.feed_post` harness unit, read fresh on every call from the run's
 * pinned version (or the active one outside a run), so a scheduled routine run and the tool
 * description can never drift apart. The text lives only in `harness/tool/feed_post.md`.
 */
import { currentHarnessVersion, renderHarnessUnit } from '../harness/loader.js';

/** The Feed posting guidance, built fresh for each fire. */
export function postingGuidance(): string {
  return renderHarnessUnit(currentHarnessVersion(), 'tool.feed_post');
}
