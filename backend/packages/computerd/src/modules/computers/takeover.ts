/**
 * What changed in the agent's browser while the user held the screen. The user's input is never
 * recorded: only a snapshot at take-over and one at hand-back (chromium pid plus tab URLs and titles)
 * are compared. Page titles are untrusted data; they are quoted and bounded here and wrapped again in
 * <untrusted> when the agent reads them.
 */
import type { E2bBinding, SurfaceSnapshot } from '@agent-desktop/contracts';
import type { ComputerProvider } from '@agent-desktop/sandbox-adapters';
import { pidDir } from '@agent-desktop/sandbox-adapters';

export type BrowserSnapshot = SurfaceSnapshot;

const MAX_LINES = 8;

/** Best effort: a browser that cannot be read yields a snapshot without tabs, never an error. */
export async function snapshotBrowser(
  provider: ComputerProvider,
  binding: E2bBinding,
  agentId: string,
  displayNo: number,
  signal: AbortSignal,
): Promise<BrowserSnapshot> {
  const snapshot: BrowserSnapshot = {};
  try {
    const pid = await provider.act(binding, agentId, displayNo, { kind: 'shell', input: { command: `cat ${pidDir(displayNo)}/chromium.pid 2>/dev/null`, timeoutMs: 5_000 } }, signal);
    const text = pid.shell?.stdout.trim() ?? '';
    if (/^\d+$/.test(text)) snapshot.pid = text;
  } catch {
    // no pid: the restart check is skipped
  }
  try {
    const tabs = await provider.act(binding, agentId, displayNo, { kind: 'browser', input: { action: 'tabs' } }, signal);
    if (tabs.browser?.action === 'tabs') snapshot.tabs = tabs.browser.tabs.map((t) => ({ tab: t.tab, url: t.url, title: t.title }));
  } catch {
    // unreadable browser: tabs stay absent
  }
  return snapshot;
}

type Tab = { tab: string; url: string; title: string };
const quote = (title: string) => JSON.stringify(title.replace(/\s+/g, ' ').trim().slice(0, 80));
const at = (t: Tab) => `${t.url.slice(0, 200)} (title ${quote(t.title)})`;

/** Short lines describing the browser change between two snapshots; empty when nothing changed. */
export function diffSnapshots(before: BrowserSnapshot | undefined, after: BrowserSnapshot): string[] {
  if (!after.tabs) return ['the browser state could not be read'];
  const now = after.tabs.slice(0, 5).map((t) => `${t.tab} ${at(t)}`).join('; ') || 'none';
  const restarted = before?.pid !== undefined && after.pid !== undefined && before.pid !== after.pid;
  if (restarted) return [`browser was closed and restarted; tabs now: ${now}`];
  if (!before?.tabs) return [`tabs now: ${now}`];
  const lines: string[] = [];
  const old = new Map(before.tabs.map((t) => [t.tab, t]));
  const current = new Set(after.tabs.map((t) => t.tab));
  for (const t of after.tabs) {
    const prev = old.get(t.tab);
    if (!prev) lines.push(`new tab ${t.tab} ${at(t)}`);
    else if (prev.url !== t.url || prev.title !== t.title) lines.push(`tab ${t.tab} now ${at(t)}`);
  }
  for (const t of before.tabs) if (!current.has(t.tab)) lines.push(`tab ${t.tab} was closed`);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `and ${lines.length - MAX_LINES} more changes`] : lines;
}
