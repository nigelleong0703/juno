import { createHash } from 'node:crypto';
import type { ToolResult } from '../../../contracts/index.js';
import { browserResultSchema, type ComputerTarget } from './contract.js';
import { snapshotText } from '../tools/computerBrowserActions.js';
import type { AdvanceObservation, SnapshotPage } from './browser-advance-types.js';

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseSnapshot(value: unknown): SnapshotPage | null {
  if (value === undefined) return null;
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = recordOf(candidate);
  if (record === undefined) return null;
  const withAction = record['action'] === undefined && Array.isArray(record['nodes']) ? { ...record, action: 'snapshot' } : record;
  const parsed = browserResultSchema.safeParse(withAction);
  return parsed.success && parsed.data.action === 'snapshot' ? parsed.data : null;
}

/**
 * Read only the canonical internal observation. The model-facing snapshot text is never parsed for
 * refs or labels: page-authored names may contain convincing fake snapshot lines.
 */
export function observationFromResult(result: ToolResult): AdvanceObservation | null {
  const details = result.details ?? {};
  const page = parseSnapshot(details['browserObservation']) ?? parseSnapshot(details['snapshot']);
  if (page === null) return null;
  return { page };
}

export function snapshotJSON(page: SnapshotPage): string {
  return JSON.stringify(page);
}

export function actionTab(result: ToolResult): string | undefined {
  const details = result.details ?? {};
  const page = parseSnapshot(details['browserObservation']) ?? parseSnapshot(details['snapshot']);
  if (page !== null) return page.tab;
  const nowOn = details['nowOn'];
  return typeof nowOn === 'string' ? nowOn : undefined;
}

function normalized(page: SnapshotPage): unknown {
  return {
    url: page.url,
    title: page.title,
    dialog: page.dialog,
    nodes: page.nodes.map((node) => ({
      role: node.role,
      name: node.name,
      disabled: node.disabled === true,
      state: (node.state ?? []).filter((flag) => flag !== 'focused').sort(),
      value: node.value,
      group: node.group,
      heading: node.heading,
      text: node.text,
    })),
  };
}

/** Ref rotation and focus changes are not progress. */
export function observationFingerprint(observation: AdvanceObservation): string {
  return createHash('sha256').update(JSON.stringify(normalized(observation.page))).digest('hex').slice(0, 24);
}

export function observedEffects(before: AdvanceObservation, after: AdvanceObservation): Array<Record<string, unknown>> {
  const effects: Array<Record<string, unknown>> = [];
  const oldPage = before.page;
  const newPage = after.page;
  for (const key of ['url', 'title', 'dialog'] as const) {
    if (JSON.stringify(oldPage[key]) !== JSON.stringify(newPage[key])) effects.push({ kind: key, now: newPage[key] ?? null });
  }
  const keyOf = (node: SnapshotPage['nodes'][number]): string => [node.role, node.group ?? '', node.name].join('\u0000');
  const oldNodes = new Map<string, SnapshotPage['nodes'][number]>();
  for (const node of oldPage.nodes) oldNodes.set(keyOf(node), node);
  for (const node of newPage.nodes) {
    const old = oldNodes.get(keyOf(node));
    if (old === undefined) continue;
    if (old.value !== node.value) effects.push({ kind: 'value', control: node.name, now: node.value ?? null });
    if (JSON.stringify(old.state?.filter((state) => state !== 'focused').sort()) !== JSON.stringify(node.state?.filter((state) => state !== 'focused').sort())) {
      effects.push({ kind: 'state', control: node.name, now: node.state ?? null });
    }
    if (old.disabled !== node.disabled) effects.push({ kind: 'disabled', control: node.name, now: node.disabled === true });
    if (effects.length >= 12) break;
  }
  if (effects.length === 0 && JSON.stringify(normalized(oldPage)) !== JSON.stringify(normalized(newPage))) effects.push({ kind: 'controls_or_headings_changed' });
  return effects.slice(0, 12);
}

/** Render the one canonical snapshot page both the model and later internal consumers receive. */
export function renderObservation(observation: AdvanceObservation, agentId: string, on: ComputerTarget | undefined): string {
  return snapshotText(observation.page, agentId, on);
}
