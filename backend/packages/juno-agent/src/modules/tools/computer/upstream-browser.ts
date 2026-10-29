/** Only transport/observation/effect adaptation. Decisions and thresholds live in the pinned upstream. */
import { createHash } from 'node:crypto';
import { UpstreamGoalSession, type Page, type Question, type Action } from '../../../../third-party/jev-browser/core.mjs';
import type { ToolContext, ToolOrchestrationRuntime, ToolResult, ToolOrchestrationAction } from '../../../contracts/index.js';
import type { SystemOneQuestion } from '../../../ports/system-one/index.js';
import { observationFromResult, actionTab } from './browser-advance-observation.js';
import type { SnapshotPage } from './browser-advance-types.js';

export interface ChromeGoalScope { on?: 'sandbox' | 'mac'; tab?: string }
export function chromeGoalSession(ctx: ToolContext, runtime: ToolOrchestrationRuntime, scope: ChromeGoalScope, onSnapshot?: (page: Page, tab: string | undefined) => Promise<void>) {
  const session = new UpstreamGoalSession();
  session.stats = { calls: 0, jev_ms: 0, tokens: 0 }; session.events = []; session.highlight = false; session.heldDialog = null;
  let tab = scope.tab; let latest: SnapshotPage | undefined; let callIndex = 0;
  let stopped: ToolResult | undefined; let cancelled = false;
  const effects: Array<{ action: string; target?: string }> = [];
  const guard = (): void => { runtime.signal.throwIfAborted(); if (cancelled || stopped) throw new Error('Juno execution stopped'); };
  const run = async (action: ToolOrchestrationAction, args: Record<string, unknown>): Promise<ToolResult> => {
    guard();
    const outcome = await runtime.run(action, { ...(tab ? { tab } : {}), ...args, ...(scope.on ? { on: scope.on } : {}) });
    if (outcome.kind === 'cancelled') { cancelled = true; throw new Error('Juno execution cancelled'); }
    const result = outcome.result;
    if (result.suspend || result.isError) { stopped = result; session.heldDialog = { message: 'Juno execution requires handoff', p_irreversible: 1 }; throw new Error('Juno execution stopped'); }
    const page = observationFromResult(result)?.page;
    if (page) latest = page;
    tab = page?.tab ?? actionTab(result) ?? tab;
    return result;
  };
  session.page = { url: () => latest?.url ?? '', title: async () => latest?.title ?? '' };
  // Readiness and ownership belong to the existing Chrome helper; no second browser is launched.
  session.settle = async () => { guard(); };
  session.webmcpTools = async () => []; // The existing Chrome contract does not expose page WebMCP yet.
  session.snapshot = async (): Promise<Page> => {
    await run('snapshot', { ...(tab ? { tab } : {}), upstream: true });
    if (!latest) throw new Error('Missing canonical browser observation');
    if (!latest.upstream) throw new Error('Upstream DOM observation unavailable; update the Chrome helper');
    const page = latest.upstream as Page;
    session.lastPage = page;
    await onSnapshot?.(page, tab);
    return page;
  };
  session.call = async (state: unknown, questions: Record<string, Question>) => {
    guard(); if (!ctx.systemOne) throw new Error('Native System One unavailable');
    const key = 'upstream-native-' + String(callIndex++); const started = Date.now();
    const mapped: Record<string, SystemOneQuestion> = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === 'choice' ? { type: 'choice', instructions: q.instructions, options: q.criteria ?? {} } : { type: 'noul', instructions: q.instructions }]));
    const hash = (value: string): string => 'juno-' + createHash('sha256').update(value).digest('hex').slice(0, 32);
    const a = await runtime.journal(key, () => ctx.systemOne!.ask(JSON.stringify(session.redact(state)), mapped, runtime.signal, { allowEmulation: false, stateEncoding: 'json', sessionId: hash(ctx.ownerId + ':' + ctx.agentId + ':' + ctx.conversationId), requestId: hash(ctx.runId) }));
    guard(); if (!a) throw new Error('Native System One unavailable');
    const answers = Object.fromEntries(Object.entries(a).map(([k, value]) => [k, value.type === 'noul' ? { type: 'noul', noul: value.probability } : value]));
    const ms = Date.now() - started; session.stats.calls++; session.stats.jev_ms += ms;
    return { answers, ms, tokens: 0 }; // The port does not expose native billing; never invent it.
  };
  session.act = async (action: Action): Promise<number> => {
    guard(); const started = Date.now();
    const element = session.lastPage?.elements.find(e => e.i === action.target);
    const ref = typeof element?.['ref'] === 'string' ? element['ref'] : undefined;
    if (action.tool === 'click' && ref) await run('click', { ref });
    else if (action.tool === 'type' && ref && typeof action.value === 'string') await run('type', { ref, text: action.value });
    else if (action.tool === 'scroll') {
      const target = session.lastPage?.elements.find(e => e.i === action.scrollTarget);
      const result = await run('scroll', { ...(tab ? { tab } : {}), ...(typeof target?.ref === 'string' ? { ref: target.ref } : {}), direction: action.direction === 'up' ? 'up' : 'down' });
      action.scrolled = result.details?.scrolled;
      if (typeof action.scrolled === 'number') action.result = 'scroll displacement: ' + String(action.scrolled) + ' px';
    }
    else throw new Error('Chrome adapter has no canonical operation for ' + action.tool);
    effects.push({ action: action.tool, ...(element?.label ? { target: element.label } : {}) });
    return Date.now() - started;
  };
  session.extractBlocks = async () => {
    const result = await run('get_text', { ...(tab ? { tab } : {}) });
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { url: latest?.url ?? '', title: latest?.title ?? '', blocks: text.split(/\n\s*\n/).filter(Boolean).map(text => ({ text })), truncated: false };
  };
  return { session, effects, tab: () => tab, stopped: () => stopped, cancelled: () => cancelled };
}
