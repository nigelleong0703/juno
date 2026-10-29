/**
 * Incremental browser observations: the first snapshot of a scope's tab reads in full, later snapshots
 * of the same tab only describe what changed. Baselines are keyed by the full trusted scope (owner +
 * agent + conversation + run + target + tab), bounded (LRU) and expiring (TTL). A full observation
 * follows: no/expired baseline, an explicit full request, a relaunch, a dialog, new notices, a compaction
 * reset, a changed URL/title/omitted/frames/prose signature, a ref rotation with no stable ref in common,
 * a reorder of surviving refs, or more changes than BROWSER_OBSERVATION_MAX_DELTA_ITEMS. The diff runs
 * over the fitted (model-visible) content only; the raw page is untouched here, so callers still remember
 * every label for the purchase gate and keep the full page in the tool details.
 */
import type { ComputerTarget } from '../../../ports/computer/index.js';

/** The trusted scope an observation belongs to: the run identity plus target and tab. Never model-claimed. */
export interface BrowserObservationScope {
  ownerId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  target: ComputerTarget;
  tab: string;
}

/** A model-visible node: its stable ref and its full rendered line, so any field change is a new signature. */
export interface ObservedSnapshotNode {
  ref: string;
  line: string;
}

export interface BrowserObservationInput {
  scope: BrowserObservationScope;
  url: string;
  title: string;
  omitted?: number | undefined;
  crossOriginFrames: number;
  /** A dialog blocks the tab: its message must be shown in full. */
  blocked: boolean;
  /** Alerts, opened or closed tabs accompanied this result: new information, shown in full. */
  notices: boolean;
  /** The browser was relaunched to serve this call: tabs and refs may have reset. */
  restarted: boolean;
  /** Latest compaction epoch of the session (null when never compacted). A change resets to full. */
  compactionEpoch: number | null;
  /** The model asked for the complete list again (browser.snapshot full:true). */
  forceFull?: boolean | undefined;
  /** Rendered heading lines in order (context without refs). */
  headings: string[];
  /** Signature over fitted non-ref, non-heading lines (prose the budget kept): a change reads in full. */
  textSig: string;
  /** Fitted (model-visible) ref nodes in order. */
  nodes: ObservedSnapshotNode[];
  /** For tests: the clock to read and stamp. Defaults to Date.now(). */
  now?: number | undefined;
}

export type BrowserObservationDecision =
  | { kind: 'full' }
  | { kind: 'unchanged' }
  | {
      kind: 'delta';
      added: ObservedSnapshotNode[];
      removed: ObservedSnapshotNode[];
      updated: Array<{ ref: string; before: string; after: string }>;
      headingsChanged: boolean;
      headings: string[];
    };

/** Scopes kept before the oldest is evicted. */
export const BROWSER_OBSERVATION_MAX_SCOPES = 300;
/** A baseline older than this reads the page in full again. */
export const BROWSER_OBSERVATION_TTL_MS = 15 * 60 * 1000;
/** More changed items than this reads the page in full instead of a misleading wall of diff. */
export const BROWSER_OBSERVATION_MAX_DELTA_ITEMS = 32;

type Baseline = {
  at: number;
  epoch: number | null;
  url: string;
  title: string;
  omitted: number | undefined;
  crossOriginFrames: number;
  blocked: boolean;
  notices: boolean;
  headingSig: string;
  headings: string[];
  textSig: string;
  byRef: Map<string, string>;
};

/** Per-process baselines, keyed by the full trusted scope: no cross-owner or cross-run leakage. */
const baselines = new Map<string, Baseline>();

/** The store key, or undefined when the scope is incomplete (then the page reads in full and nothing is stored). */
export function browserObservationKey(scope: BrowserObservationScope): string | undefined {
  const parts = [scope.ownerId, scope.agentId, scope.conversationId, scope.runId, scope.target, scope.tab];
  if (parts.some((part) => typeof part !== 'string' || part.length === 0)) return undefined;
  return JSON.stringify(parts);
}

/** Drop expired baselines and evict the oldest scopes past the bound. */
function prune(now: number): void {
  for (const [key, baseline] of baselines) {
    if (now - baseline.at > BROWSER_OBSERVATION_TTL_MS) baselines.delete(key);
  }
  while (baselines.size > BROWSER_OBSERVATION_MAX_SCOPES) {
    const oldest = baselines.keys().next();
    if (oldest.done) break;
    baselines.delete(oldest.value);
  }
}

/** Forget every baseline. Tests use it for isolation; production never calls it. */
export function clearBrowserObservationState(): void {
  baselines.clear();
}

/** Compare this snapshot against the scope baseline. Always advances the baseline to the current page. */
export function observeBrowserSnapshot(input: BrowserObservationInput): BrowserObservationDecision {
  const now = input.now ?? Date.now();
  const key = browserObservationKey(input.scope);
  const snap = (): Baseline => ({
    at: now,
    epoch: input.compactionEpoch,
    url: input.url,
    title: input.title,
    omitted: input.omitted,
    crossOriginFrames: input.crossOriginFrames,
    blocked: input.blocked,
    notices: input.notices,
    headingSig: input.headings.join('\n'),
    headings: [...input.headings],
    textSig: input.textSig,
    byRef: new Map(input.nodes.map((node) => [node.ref, node.line])),
  });
  const storeFull = (): BrowserObservationDecision => {
    if (key !== undefined) {
      baselines.set(key, snap());
      prune(now);
    }
    return { kind: 'full' };
  };
  if (key === undefined || input.forceFull === true) return storeFull();
  const prev = baselines.get(key);
  if (prev === undefined || now - prev.at > BROWSER_OBSERVATION_TTL_MS) return storeFull();
  // Anything but the same quiet page reads in full: a relaunch, a dialog, new
  // notices, a compaction reset, or a changed URL/title/omitted/frames/prose. Never claim unchanged then.
  if (
    input.restarted || input.blocked || input.notices || prev.blocked || prev.notices ||
    input.compactionEpoch !== prev.epoch ||
    input.url !== prev.url || input.title !== prev.title ||
    input.omitted !== prev.omitted || input.crossOriginFrames !== prev.crossOriginFrames ||
    input.textSig !== prev.textSig
  ) {
    return storeFull();
  }
  const current = new Map(input.nodes.map((node) => [node.ref, node.line]));
  // No stable ref in common (a target that re-mints ids) is a rotation, not a
  // rewrite of every control: read in full instead of a misleading delta.
  if (prev.byRef.size > 0 && current.size > 0) {
    let common = false;
    for (const ref of current.keys()) {
      if (prev.byRef.has(ref)) {
        common = true;
        break;
      }
    }
    if (!common) return storeFull();
  }
  // A new order among surviving refs (a re-sorted list) is never "unchanged": position carries meaning
  // (first, cheapest). Only a full list shows the true order, so a reorder always reads in full.
  const before: string[] = [];
  for (const ref of prev.byRef.keys()) if (current.has(ref)) before.push(ref);
  const after: string[] = [];
  for (const node of input.nodes) if (prev.byRef.has(node.ref)) after.push(node.ref);
  if (before.join('\n') !== after.join('\n')) return storeFull();
  const added: ObservedSnapshotNode[] = [];
  const updated: Array<{ ref: string; before: string; after: string }> = [];
  for (const node of input.nodes) {
    const before = prev.byRef.get(node.ref);
    if (before === undefined) added.push(node);
    else if (before !== node.line) updated.push({ ref: node.ref, before, after: node.line });
  }
  const removed: ObservedSnapshotNode[] = [];
  for (const [ref, line] of prev.byRef) {
    if (!current.has(ref)) removed.push({ ref, line });
  }
  const headingsChanged = input.headings.join('\n') !== prev.headingSig;
  const changed = added.length + removed.length + updated.length + (headingsChanged ? input.headings.length : 0);
  if (changed === 0) {
    prev.at = now;
    baselines.delete(key);
    baselines.set(key, prev);
    return { kind: 'unchanged' };
  }
  if (changed > BROWSER_OBSERVATION_MAX_DELTA_ITEMS) return storeFull();
  baselines.set(key, snap());
  prune(now);
  return { kind: 'delta', added, removed, updated, headingsChanged, headings: [...input.headings] };
}
