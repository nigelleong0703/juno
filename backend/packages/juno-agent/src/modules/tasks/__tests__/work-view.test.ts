/**
 * The task tree's mapping (BACKEND 6.5): every source state reads as one status and outcome, and `unknown_effect` beats the
 * rest. These are the pure functions; the write side (what sets `effectReview`, `blockCause`, `stopDelivery`) and the
 * queries are covered in work-write.test.ts and agentd's route tests.
 */
import { describe, expect, it } from 'vitest';
import type { BackgroundTask, DeclaredTask } from '../../../contracts/index.js';
import { backgroundVerdict, declaredVerdict, runVerdict, type Verdict } from '../work-view.js';

type RunState = Parameters<typeof runVerdict>[0];
const run = (state: Partial<RunState> & Pick<RunState, 'status'>): RunState => ({ ...state });

const ended = (outcome: NonNullable<Verdict['outcome']>, outcomeDetail?: NonNullable<Verdict['outcomeDetail']>): Verdict => ({ status: 'ended', outcome, ...(outcomeDetail === undefined ? {} : { outcomeDetail }) });

describe('run states', () => {
  const rows: Array<[string, RunState, Verdict]> = [
    ['scheduled', run({ status: 'scheduled' }), { status: 'queued' }],
    ['queued', run({ status: 'queued' }), { status: 'queued' }],
    ['queued, dispatch failed', run({ status: 'queued', dispatchError: 'enqueue refused' }), { status: 'queued', outcomeDetail: 'dispatch_failed' }],
    ['running', run({ status: 'running' }), { status: 'running' }],
    ['waiting for input', run({ status: 'waiting_for_input' }), { status: 'waiting', waitingFor: 'owner_input' }],
    ['completed', run({ status: 'completed' }), ended('done')],
    ['failed', run({ status: 'failed' }), ended('failed')],
    ['stopped', run({ status: 'stopped' }), ended('cancelled')],
    ['stopped by the owner', run({ status: 'stopped', stoppedBy: 'owner' }), ended('cancelled', 'stopped_by_owner')],
    ['stopped by the agent', run({ status: 'stopped', stoppedBy: 'agent' }), ended('cancelled', 'stopped_by_agent')],
    ['stopped by the platform', run({ status: 'stopped', stoppedBy: 'system' }), ended('cancelled', 'stopped_by_system')],
    ['blocked: needs input', run({ status: 'blocked', blockCause: 'needs_input' }), ended('needs_input')],
    ['blocked: limit', run({ status: 'blocked', blockCause: 'limit' }), ended('failed', 'step_limit')],
    ['blocked: no progress', run({ status: 'blocked', blockCause: 'no_progress' }), ended('failed', 'no_progress')],
    ['blocked: verification', run({ status: 'blocked', blockCause: 'verification' }), ended('failed', 'verification_failed')],
    ['blocked: unreadable', run({ status: 'blocked', blockCause: 'unreadable' }), ended('failed', 'state_unreadable')],
    ['live with an open review', run({ status: 'running', effectReview: 'open' }), { status: 'waiting', waitingFor: 'effect_review' }],
    ['waiting for input with an open review', run({ status: 'waiting_for_input', effectReview: 'open' }), { status: 'waiting', waitingFor: 'effect_review' }],
    ['completed, review settled', run({ status: 'completed', effectReview: 'resolved' }), ended('done')],
    // unknown_effect wins over every terminal state.
    ['completed, review open', run({ status: 'completed', effectReview: 'open' }), ended('unknown_effect', 'effect_review')],
    ['failed, review open', run({ status: 'failed', effectReview: 'open' }), ended('unknown_effect', 'effect_review')],
    ['stopped, review open', run({ status: 'stopped', effectReview: 'open' }), ended('unknown_effect', 'effect_review')],
    ['blocked, review open', run({ status: 'blocked', blockCause: 'limit', effectReview: 'open' }), ended('unknown_effect', 'effect_review')],
  ];
  it.each(rows)('%s', (_name, state, expected) => {
    expect(runVerdict(state)).toEqual(expected);
  });

  it('a waiting run asks for an approval when its pending request is one', () => {
    expect(runVerdict(run({ status: 'waiting_for_input' }), 'approval')).toEqual({ status: 'waiting', waitingFor: 'approval' });
  });
});

describe('background jobs', () => {
  const job = (state: Pick<BackgroundTask, 'kind' | 'status'> & { stopDelivery?: BackgroundTask['stopDelivery']; stoppedBy?: BackgroundTask['stoppedBy'] }): Pick<BackgroundTask, 'kind' | 'status' | 'stopDelivery' | 'stoppedBy'> => state;
  const rows: Array<[string, ReturnType<typeof job>, Verdict]> = [
    ['shell running', job({ kind: 'shell', status: 'running' }), { status: 'running' }],
    ['mcp running', job({ kind: 'mcp', status: 'running' }), { status: 'running' }],
    ['wait running', job({ kind: 'wait', status: 'running' }), { status: 'waiting', waitingFor: 'event' }],
    ['completed', job({ kind: 'shell', status: 'completed' }), ended('done')],
    ['failed', job({ kind: 'mcp', status: 'failed' }), ended('failed')],
    ['timeout', job({ kind: 'mcp', status: 'timeout' }), ended('failed', 'timed_out')],
    ['shell stopped', job({ kind: 'shell', status: 'stopped' }), ended('cancelled')],
    ['wait stopped', job({ kind: 'wait', status: 'stopped' }), ended('cancelled')],
    ['shell stopped by the owner', job({ kind: 'shell', status: 'stopped', stoppedBy: 'owner' }), ended('cancelled', 'stopped_by_owner')],
    ['wait stopped by the agent', job({ kind: 'wait', status: 'stopped', stoppedBy: 'agent' }), ended('cancelled', 'stopped_by_agent')],
    ['mcp stopped by the owner, abort delivered', job({ kind: 'mcp', status: 'stopped', stopDelivery: 'aborted', stoppedBy: 'owner' }), ended('cancelled', 'stopped_by_owner')],
    ['mcp stopped by the owner, only marked', job({ kind: 'mcp', status: 'stopped', stopDelivery: 'marked', stoppedBy: 'owner' }), ended('unknown_effect', 'stop_unconfirmed')],
    ['mcp stopped, abort delivered', job({ kind: 'mcp', status: 'stopped', stopDelivery: 'aborted' }), ended('cancelled')],
    ['mcp stopped, only marked', job({ kind: 'mcp', status: 'stopped', stopDelivery: 'marked' }), ended('unknown_effect', 'stop_unconfirmed')],
    ['mcp stopped before delivery was recorded', job({ kind: 'mcp', status: 'stopped' }), ended('cancelled')],
  ];
  it.each(rows)('%s', (_name, state, expected) => {
    expect(backgroundVerdict(state)).toEqual(expected);
  });
});

describe('declared tasks', () => {
  const task = (status: DeclaredTask['status'], stoppedBy?: DeclaredTask['stoppedBy']): Pick<DeclaredTask, 'status' | 'stoppedBy'> => ({ status, ...(stoppedBy === undefined ? {} : { stoppedBy }) });
  const rows: Array<[string, ReturnType<typeof task>, Verdict]> = [
    ['running', task('running'), { status: 'running' }],
    ['waiting', task('waiting'), { status: 'waiting', waitingFor: 'owner_input' }],
    ['completed', task('completed'), ended('done')],
    ['failed', task('failed'), ended('failed')],
    ['stopped with its run', task('stopped'), ended('cancelled')],
    ['stopped by the owner', task('stopped', 'owner'), ended('cancelled', 'stopped_by_owner')],
  ];
  it.each(rows)('%s', (_name, state, expected) => {
    expect(declaredVerdict(state)).toEqual(expected);
  });
});
