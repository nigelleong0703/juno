/** Juno's factual stage contract. Does not participate in upstream decisions. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Page } from '../../../../third-party/jev-browser/core.mjs';
import type { BrowserCompletion, BrowserGoalGate, BrowserVerification, Store, ToolContext } from '../../../contracts/index.js';

export function verifyBrowserCompletion(page: Page, completion: BrowserCompletion): BrowserVerification {
  const conditions = completion.map(condition => {
    const result = (passed: boolean, reason: string, observed?: string | number | boolean) => ({ condition, passed, reason, ...(observed !== undefined ? { observed } : {}) });
    // Missing frames and truncated identifiers cannot establish absence or uniqueness.
    if (Number(page.metrics?.skippedFrames ?? 0) > 0) return result(false, 'incomplete_page_coverage');
    const entries = Object.entries(condition.match);
    const matches = page.elements.filter(e => entries.every(([k, v]) => e[k] === v));
    if (condition.property === 'count') return result(matches.length === condition.equals, 'matching_control_count', matches.length);
    if (matches.length !== 1) return result(false, matches.length ? 'ambiguous_control' : 'control_not_observed', matches.length);
    const element = matches[0]!;
    const value = element[condition.property];
    if (element.tag === 'input:password' || value === '[redacted]') return result(false, 'secure_value_not_verifiable');
    if (typeof value !== typeof condition.equals) return result(false, 'property_not_observed');
    // The pinned collector normalizes and caps values; a full-length prefix is not proof of equality.
    const cap = element.tag === 'select' ? 40 : /^input:(checkbox|radio)$/.test(element.tag) ? 30 : 60;
    if (typeof value === 'string' && value.length >= cap) return result(false, 'value_may_be_truncated');
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return result(false, 'property_not_observed');
    return result(value === condition.equals, 'observed_property', value);
  });
  return { passed: conditions.every(c => c.passed), conditions };
}

export function browserGoalGate(ctx: ToolContext, on: 'sandbox' | 'mac' = 'sandbox') {
  const store = ctx.store.forOwner?.(ctx.ownerId) ?? ctx.store;
  const id = 'bg-' + createHash('sha256').update(JSON.stringify([ctx.ownerId, ctx.agentId, ctx.conversationId, ctx.runId, on])).digest('hex');
  const read = () => store.get('browserGoalGates', id);
  const locked = async <T>(fn: (tx: Store) => Promise<T>): Promise<T> => store.tx(async tx => {
    // Side-effecting tools are serialized by the canonical runner. Lock the existing run as well
    // so two first calls cannot both create a gate (SELECT FOR UPDATE on a missing gate cannot).
    if (!tx.getForUpdate) throw new Error('Browser gate requires transactional row locking');
    const run = await tx.getForUpdate('runs', ctx.runId);
    if (!run || run.agentId !== ctx.agentId || run.conversationId !== ctx.conversationId) throw new Error('Invalid browser gate scope');
    return fn(tx);
  });
  return {
    read,
    async begin(goal: string, completion: BrowserCompletion | undefined, recover: boolean, tab?: string) {
      return locked(async tx => {
        const prior = await tx.get('browserGoalGates', id);
        if (prior?.status === 'abandoned') return { blocked: prior };
        if (prior?.status === 'pending') {
          if ((recover || prior.stageId === ctx.stepId) && (!tab || !prior.tab || tab === prior.tab) && (recover || prior.goal === goal && isDeepStrictEqual(prior.completion, completion))) return { gate: prior };
          return { blocked: prior };
        }
        if (recover || !completion || !ctx.stepId) throw new Error('Missing browser stage contract');
        const gate: BrowserGoalGate = { id, ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, runId: ctx.runId, stageId: ctx.stepId, on, ...(tab ? { tab } : {}), goal, completion, status: 'pending', updatedAt: new Date().toISOString() };
        // Commit BEFORE any page read / inference / mutation; failures leave the original contract pending.
        await tx.put('browserGoalGates', gate);
        return { gate };
      });
    },
    async bindTab(gate: BrowserGoalGate, tab: string | undefined) {
      if (!tab) throw new Error('Browser gate requires a resolved tab');
      await locked(async tx => {
        const current = await tx.get('browserGoalGates', id);
        if (!current || current.stageId !== gate.stageId || current.status !== 'pending' || current.tab && current.tab !== tab) throw new Error('Browser gate tab changed');
        if (!current.tab) await tx.patch('browserGoalGates', id, { tab });
      });
    },
    async observe(gate: BrowserGoalGate, page: Page, tab?: string) {
      const verification = verifyBrowserCompletion(page, gate.completion);
      return locked(async tx => {
        const current = await tx.get('browserGoalGates', id);
        if (!current || current.stageId !== gate.stageId || current.status !== 'pending' || current.tab && current.tab !== tab) throw new Error('Stale browser stage observation');
        await tx.put('browserGoalGates', { ...current, ...(tab ? { tab } : {}), verification, status: verification.passed ? 'verified' : 'pending', updatedAt: new Date().toISOString() });
        return verification;
      });
    },
    async abandon(reason: string) {
      return locked(async tx => {
        const gate = await tx.get('browserGoalGates', id);
        if (!gate || gate.status !== 'pending') throw new Error('No pending browser goal');
        await tx.put('browserGoalGates', { ...gate, status: 'abandoned', reason, updatedAt: new Date().toISOString() });
        return { status: 'abandoned', goal: gate.goal, reason, verified: false };
      });
    },
  };
}
