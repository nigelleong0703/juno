/** Goal-style interface over Juno's existing Chrome tools. No browser process is owned here. */
import { z } from 'zod';
import { formatPage } from '../../../../third-party/jev-browser/page-model.mjs';
import type { Page } from '../../../../third-party/jev-browser/core.mjs';
import { browserCompletionSchema } from '../../../contracts/index.js';
import { draftBrowserText } from '../computer/browser-text.js';
import { browserGoalGate } from '../computer/browser-goal-gate.js';
import type { BrowserGoalGate, Tool, ToolResult } from '../../../contracts/index.js';
import { chromeGoalSession } from '../computer/upstream-browser.js';
import { observationFromResult } from '../computer/browser-advance-observation.js';
import { ON_SCHEMA } from '../computer/shared.js';

export const GOAL_BROWSER_NAMES = ['browser.open', 'browser.do', 'browser.read', 'browser.check', 'browser.act'] as const;
const where = { on: ON_SCHEMA, tab: z.string().min(1).max(16).optional() };
const browserGoalInput = z.object({ ...where, goal: z.string().trim().min(1).max(2000), values: z.record(z.string().min(1).max(240), z.string().max(2000)).optional(), maxActions: z.number().int().min(1).max(30).optional(), completion: browserCompletionSchema.optional(), recover: z.boolean().optional() }).strict().refine(a => a.recover ? a.completion === undefined : a.completion !== undefined, 'New stages require completion; recovery retains the original conditions').refine(a => Object.keys(a.values ?? {}).length <= 24 && !Object.keys(a.values ?? {}).some(k => /password|passcode|otp|cvv|cvc|card.number|secret/i.test(k)), 'Use secure input for secrets; at most24 supplied values');
const readSchema = z.object({ ...where, question: z.string().trim().min(1).max(2000) }).strict();
const fail = (code: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ code }) }], isError: true, details: { code } });
const observedPage = (page: Page | undefined) => page ? {
  current_page: formatPage({ ...page, elements: page.elements.map(e => ({ ...e, hint: [e['hint'], typeof e['ref'] === 'string' ? 'ref=' + e['ref'] : '', e.readonly ? 'readonly' : ''].filter(Boolean).join(' ') })) }, { interactive: true, maxChars: 2400 }),
  metrics: page.metrics, observation_timing: 'last_snapshot',
} : undefined;
const withObservedPage = (result: ToolResult, page: Page | undefined): ToolResult => page && !result.suspend ? { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ handoff: observedPage(page) }) }] } : result;
const textResult = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const pendingResult = (gate: BrowserGoalGate): ToolResult => ({ ...textResult({ code: gate.status === 'abandoned' ? 'browser_goal_abandoned' : 'previous_browser_goal_pending', pending: gate, next: gate.status === 'abandoned' ? 'Report this stage as unverified; browser work has ended for this run.' : 'Recover with recover:true and unchanged conditions, or browser.act. Abandonment ends browser work for this run.' }), isError: true });

export function createGoalBrowserTools(): Tool[] {
  const tool = (name: string, description: string, parameters: Record<string, unknown>, sideEffect: boolean, orchestrate: NonNullable<Tool['orchestrate']>): Tool => ({ name, description, parameters, sideEffect, deferLoading: true, replay: sideEffect ? 'never' : 'safe', execute: async () => fail('canonical_orchestrator_required'), async orchestrate(args, ctx, runtime) { try { return await orchestrate(args, ctx, runtime); } catch (e) { if (runtime.signal.aborted) return { kind: 'cancelled' }; return { kind: 'completed', result: e instanceof z.ZodError ? { ...textResult({ code: 'invalid_browser_arguments', issues: e.issues.slice(0, 3).map(issue => ({ path: issue.path, message: issue.message })) }), isError: true, details: { code: 'invalid_browser_arguments' } } : fail('browser_goal_failed') }; } } });
  const properties = { on: { type: 'string', enum: ['sandbox', 'mac'] }, tab: { type: 'string' } };
  const schema = (fields: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties: { ...properties, ...fields }, required, additionalProperties: false });
  return [
    tool('browser.open', '', schema({ url: { type: 'string' } }, ['url']), true, async (args, ctx, runtime) => {
      const parsed = z.object({ ...where, url: z.string().url().refine(u => /^https?:/.test(u)) }).strict().parse(args);
      const pending = await browserGoalGate(ctx, parsed.on).read();
      if (pending && pending.status !== 'verified') return { kind: 'completed', result: pendingResult(pending) };
      const outcome = await runtime.run('navigate', parsed);
      if (outcome.kind !== 'completed' || outcome.result.isError || outcome.result.suspend) return outcome;
      const page = observationFromResult(outcome.result)?.page;
      return { kind: 'completed', result: textResult({ status: 'opened', url: page?.url, title: page?.title, observedControls: page?.nodes.filter(n => n.ref).length, next: 'Use browser.do with one goal and exact known values.' }) };
    }),
    tool('browser.do', '', { ...schema({ goal: { type: 'string' }, values: { type: 'object', additionalProperties: { type: 'string' } }, completion: z.toJSONSchema(browserCompletionSchema), recover: { type: 'boolean', description: '' }, maxActions: { type: 'integer', minimum: 1, maximum: 30, default: 10 } }, ['goal']), anyOf: [{ required: ['completion'], properties: { recover: { const: false } } }, { required: ['recover'], properties: { recover: { const: true } }, not: { required: ['completion'] } }] }, true, async (args, ctx, runtime) => {
      const parsed = browserGoalInput.parse(args);
      const gateStore = browserGoalGate(ctx, parsed.on);
      const begun = await gateStore.begin(parsed.goal, parsed.completion, parsed.recover ?? false, parsed.tab);
      if (begun.blocked) return { kind: 'completed', result: pendingResult(begun.blocked) };
      const gate = begun.gate;
      const bridge = chromeGoalSession(ctx, runtime, { ...parsed, tab: gate.tab ?? parsed.tab }, async (_page, tab) => gateStore.bindTab(gate, tab));
      try {
        const out = await bridge.session.runGoal(parsed.goal, { values: parsed.values ?? {}, maxActions: parsed.maxActions ?? 10 });
        const stopped = bridge.stopped();
        if (stopped) return { kind: 'completed', result: withObservedPage(stopped, bridge.session.lastPage) };
        // Fresh read after the loop: lastPage may predate its last action or an error.
        const page = await bridge.session.snapshot();
        const verification = await gateStore.observe(gate, page, bridge.tab());
        const { rounds: _rounds, ...summary } = out;
        return { kind: 'completed', result: { ...textResult({ verification, pending: !verification.passed, ...summary, handoff: observedPage(page) }), details: { upstream: '74592ba', stopReason: out.status, actionCount: bridge.effects.length, verified: verification.passed } } };
      } catch {
        if (runtime.signal.aborted || bridge.cancelled()) return { kind: 'cancelled' };
        return { kind: 'completed', result: withObservedPage(bridge.stopped() ?? fail('upstream_browser_handoff'), bridge.session.lastPage) };
      }
    }),
    ...(['read', 'check'] as const).map(kind => tool('browser.' + kind, '', schema({ question: { type: 'string' } }, ['question']), false, async (args, ctx, runtime) => {
      const parsed = readSchema.parse(args);
      const bridge = chromeGoalSession(ctx, runtime, parsed);
      try {
        const result = kind === 'check' ? { question: parsed.question, p_yes: await bridge.session.check(parsed.question) } : await bridge.session.read(parsed.question);
        return { kind: 'completed', result: bridge.stopped() ?? textResult(result) };
      } catch {
        if (runtime.signal.aborted || bridge.cancelled()) return { kind: 'cancelled' };
        return { kind: 'completed', result: bridge.stopped() ?? fail('upstream_browser_handoff') };
      }
    })),
    tool('browser.act', '', schema({ action: { type: 'string', enum: ['snapshot', 'click', 'type', 'fill', 'get_text', 'scroll', 'write', 'abandon'] }, args: { type: 'object', additionalProperties: true } }, ['action']), true, async (args, ctx, runtime) => {
      const parsed = z.object({ ...where, action: z.enum(['snapshot', 'click', 'type', 'fill', 'get_text', 'scroll', 'write', 'abandon']), args: z.record(z.string(), z.unknown()).optional() }).strict().parse(args);
      const gateStore = browserGoalGate(ctx, parsed.on);
      if (parsed.action === 'abandon') return { kind: 'completed', result: textResult(await gateStore.abandon(z.string().trim().min(1).max(1000).parse(parsed.args?.reason))) };
      const gate = await gateStore.read();
      if (gate?.status === 'abandoned') return { kind: 'completed', result: pendingResult(gate) };
      if (gate?.status === 'pending' && parsed.tab && gate.tab && parsed.tab !== gate.tab) return { kind: 'completed', result: pendingResult(gate) };
      if (parsed.args?.on !== undefined || parsed.args?.tab !== undefined) return { kind: 'completed', result: fail('scope_must_be_top_level') };
      const scope = { ...(parsed.on ? { on: parsed.on } : {}), ...(gate?.status === 'pending' && gate.tab ? { tab: gate.tab } : parsed.tab ? { tab: parsed.tab } : {}) };
      const bridge = chromeGoalSession(ctx, runtime, scope);
      try {
        if (parsed.action === 'snapshot') {
          const page = await bridge.session.snapshot();
          const verification = gate?.status === 'pending' ? await gateStore.observe(gate, page, bridge.tab()) : undefined;
          return { kind: 'completed', result: textResult({ ...(verification ? { verification, pending: !verification.passed } : {}), handoff: observedPage(page) }) };
        }
        const drafted = parsed.action === 'write' ? await draftBrowserText(parsed.args, ctx, runtime) : undefined;
        if (drafted === null) return { kind: 'completed', result: fail('browser_text_unavailable_use_exact_fill') };
        const outcome = await runtime.run(parsed.action === 'write' ? 'fill' : parsed.action, { ...(drafted ?? parsed.args), ...scope });
        if (!gate || gate.status !== 'pending' || outcome.kind !== 'completed' || outcome.result.isError || outcome.result.suspend) return outcome;
        const page = await bridge.session.snapshot();
        const verification = await gateStore.observe(gate, page, bridge.tab());
        return { kind: 'completed', result: { ...outcome.result, content: [...outcome.result.content, { type: 'text', text: JSON.stringify({ verification, pending: !verification.passed, handoff: observedPage(page) }) }] } };
      } catch {
        if (runtime.signal.aborted || bridge.cancelled()) return { kind: 'cancelled' };
        return { kind: 'completed', result: bridge.stopped() ?? fail('browser_observation_failed') };
      }
    }),
  ];
}
