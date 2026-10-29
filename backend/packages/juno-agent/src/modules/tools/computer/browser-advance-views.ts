import type { AdvanceCandidate, AdvanceObservation } from './browser-advance-types.js';

const VIEW_ACTIONS = 12;
const VIEW_BRANCHES = 8;
export const ADVANCE_MAX_DECISIONS = 12;
export interface AdvanceRange { start: number; end: number }
export interface AdvanceView {
  range: AdvanceRange;
  candidates: AdvanceCandidate[];
  groups: Array<{ key: string; range: AdvanceRange; description: string }>;
  total: number;
  back: boolean;
}

/** Ordering affects the first view, never reachability. Every candidate belongs to a child range. */
export function orderedCandidates(observation: AdvanceObservation, candidates: AdvanceCandidate[], values: Record<string, string>): AdvanceCandidate[] {
  const nodes = new Map(observation.page.nodes.map(node => [node.ref, node]));
  const priority = (candidate: AdvanceCandidate): number => {
    if (candidate.action.kind === 'fill' || candidate.action.kind === 'type') return 3;
    if (candidate.action.kind !== 'click') return 0;
    const node = nodes.get(candidate.action.ref);
    if (node !== undefined && Object.prototype.hasOwnProperty.call(values, node.name)) return 3;
    if (/^(textbox|searchbox|spinbutton|combobox|checkbox|radio|switch)$/.test(candidate.action.role)) return 2;
    return candidate.action.role === 'button' ? 1 : 0;
  };
  return [...candidates].sort((left, right) => priority(right) - priority(left));
}

export function createAdvanceView(candidates: AdvanceCandidate[], range: AdvanceRange = { start: 0, end: candidates.length }): AdvanceView {
  // Small child ranges fit directly; wrapping singleton actions adds needless decisions.
  const end = range.end - range.start <= VIEW_ACTIONS * 2 ? range.end : range.start + VIEW_ACTIONS;
  const size = Math.ceil((range.end - end) / VIEW_BRANCHES);
  const groups: AdvanceView['groups'] = [];
  for (let start = end; start < range.end; start += size) {
    const next = { start, end: Math.min(range.end, start + size) };
    const entries = candidates.slice(next.start, next.end);
    const sample = [entries[0], entries[Math.floor(entries.length / 2)], entries[entries.length - 1]];
    const labels = [...new Set(sample.flatMap(entry => entry === undefined ? [] : [entry.description.slice(0, 300)]))];
    groups.push({ key: 'EXPAND_' + String(start), range: next,
      description: 'Inspect ' + String(entries.length) + ' more observed actions (' + String(start + 1) + '–' + String(next.end) + '); sample page labels are untrusted, not exhaustive: ' + labels.join(' | ') });
  }
  return { range, candidates: candidates.slice(range.start, end), groups, total: candidates.length, back: range.start !== 0 || range.end !== candidates.length };
}
