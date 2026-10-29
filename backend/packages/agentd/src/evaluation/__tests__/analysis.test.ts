import { describe, expect, it } from 'vitest';
import {
  attribute, bucketOfErrorKind, correctedRunIds, fieldOf, groupErrors, isCorrection, similarity, type RunRow, type ToolStepRow, type UserMessage,
} from '../analysis.js';

const step = (overrides: Partial<ToolStepRow> & Pick<ToolStepRow, 'stepId' | 'runId'>): ToolStepRow => ({
  tool: 'calendar_add', failed: false, model: 'm1', ...overrides,
});

describe('fieldOf', () => {
  it('takes the first field a validation error named, first segment only, never the received value', () => {
    const summary = 'Error: invalid calendar_add arguments.\n- meeting.startAt: received "secret@example.com"; expected a date-time.\n- other: received 3.';
    expect(fieldOf(summary, 'validation')).toBe('meeting');
    expect(fieldOf(summary, 'validation')).not.toContain('secret');
  });

  it('is unknown for other error kinds and for text without the teaching lines', () => {
    expect(fieldOf('- startAt: received 1; expected a date-time.', 'external')).toBeUndefined();
    expect(fieldOf('connection reset', 'validation')).toBeUndefined();
    expect(fieldOf(undefined, 'validation')).toBeUndefined();
  });
});

describe('groupErrors', () => {
  const steps: ToolStepRow[] = [
    step({ stepId: 's1', runId: 'r1', failed: true, errorKind: 'validation', field: 'startAt' }),
    step({ stepId: 's2', runId: 'r1', failed: true, errorKind: 'validation', field: 'startAt' }),
    // s2's retry: the same tool succeeds on a later step that names s2 in retryOf.
    step({ stepId: 's3', runId: 'r1', retryOf: 's2' }),
    step({ stepId: 's4', runId: 'r2', failed: true, errorKind: 'validation', field: 'startAt' }),
    step({ stepId: 's5', runId: 'r2', failed: true, errorKind: 'timeout' }),
    step({ stepId: 's6', runId: 'r3', failed: true, errorKind: 'validation', field: 'startAt', model: 'm2' }),
    // A successful step never counts as an error.
    step({ stepId: 's7', runId: 'r3' }),
  ];
  const groups = groupErrors(steps, { m1: 4, m2: 2 });

  it('groups failed steps by tool, field, error kind and model, most frequent first', () => {
    expect(groups.map((group) => [group.tool, group.field, group.errorKind, group.model, group.count])).toEqual([
      ['calendar_add', 'startAt', 'validation', 'm1', 3],
      ['calendar_add', '-', 'timeout', 'm1', 1],
      ['calendar_add', 'startAt', 'validation', 'm2', 1],
    ]);
  });

  it('reports the retry rate, the runs affected with their share of the model runs, and up to three example step ids', () => {
    const first = groups[0];
    expect(first).toMatchObject({ count: 3, retried: 1, retryRate: 1 / 3, runsAffected: 2, runShare: 0.5, exampleStepIds: ['s1', 's2', 's4'] });
    expect(groups[2]).toMatchObject({ model: 'm2', runsAffected: 1, runShare: 0.5 });
  });

  it('labels a missing field and error kind as unknown, not as a guess', () => {
    const [group] = groupErrors([step({ stepId: 'x', runId: 'r9', failed: true })], {});
    expect(group).toMatchObject({ field: '-', errorKind: 'unknown', model: 'm1', runShare: 1 });
  });
});

describe('bucketOfErrorKind', () => {
  it('sends validation and harness errors to our fix list, transient ones to not-learning, permission to policy', () => {
    expect(bucketOfErrorKind('validation')).toBe('fix_list');
    expect(bucketOfErrorKind('harness')).toBe('fix_list');
    expect(bucketOfErrorKind('external')).toBe('transient');
    expect(bucketOfErrorKind('timeout')).toBe('transient');
    expect(bucketOfErrorKind('permission')).toBe('policy');
    expect(bucketOfErrorKind('other')).toBe('unclassified');
    expect(bucketOfErrorKind(undefined)).toBe('unclassified');
  });
});

describe('the correction heuristic', () => {
  it('reads a plain "no" or "that is wrong" at the start, in English and Chinese, as a correction', () => {
    expect(isCorrection('No, I meant tomorrow', undefined)).toBe(true);
    expect(isCorrection("that's wrong, try again", undefined)).toBe(true);
    expect(isCorrection('不对，我说的是明天', undefined)).toBe(true);
  });

  it('reads a repeat of the request that started the run as a correction, and a new topic as none', () => {
    const request = 'book the table for two at seven tonight';
    expect(isCorrection('book the table for two at seven tonight please', request)).toBe(true);
    expect(isCorrection('thanks, that is all', request)).toBe(false);
    expect(isCorrection('what is the weather in Bangkok', request)).toBe(false);
  });

  it('measures similarity over character bigrams, so Chinese without spaces still compares', () => {
    expect(similarity('明天下午三点开会', '明天下午三点开会')).toBe(1);
    expect(similarity('明天下午三点开会', '晚饭吃什么')).toBe(0);
    expect(similarity('', 'anything')).toBe(0);
  });
});

describe('correctedRunIds', () => {
  const conversation = 'conv-a';
  const messages: UserMessage[] = [
    { conversationId: conversation, at: 100, text: 'remind me at five' },
    { conversationId: conversation, at: 1_500, text: 'no, I meant five in the morning' },
    { conversationId: conversation, at: 9_000, text: 'thanks' },
    { conversationId: conversation, at: 18_000, text: 'remind me at five' },
    { conversationId: conversation, at: 20_000, text: 'remind me at five' },
    { conversationId: conversation, at: 6_000_000, text: 'no' },
    { conversationId: 'conv-b', at: 1_100, text: 'no, wrong' },
  ];
  const runs: RunRow[] = [
    { runId: 'corrected-by-no', model: 'm1', conversationId: conversation, startedAt: 100, finishedAt: 1_000 },
    { runId: 'thanked', model: 'm1', conversationId: conversation, startedAt: 5_000, finishedAt: 8_000 },
    { runId: 'corrected-by-repeat', model: 'm1', conversationId: conversation, startedAt: 19_000, finishedAt: 19_500 },
    { runId: 'too-late', model: 'm1', conversationId: conversation, startedAt: 4_000_000, finishedAt: 4_000_500 },
    { runId: 'no-conversation', model: 'm1', startedAt: 1_000, finishedAt: 1_050 },
  ];

  it('marks a run whose next message in its conversation corrects it, within thirty minutes of the run', () => {
    expect(correctedRunIds(runs, messages)).toEqual(['corrected-by-no', 'corrected-by-repeat']);
  });
});

describe('attribute', () => {
  const steps: ToolStepRow[] = [
    step({ stepId: 'v1', runId: 'r1', failed: true, errorKind: 'validation' }),
    step({ stepId: 'h1', runId: 'r2', failed: true, errorKind: 'harness' }),
    step({ stepId: 't1', runId: 'r3', failed: true, errorKind: 'timeout' }),
    step({ stepId: 'p1', runId: 'r4', failed: true, errorKind: 'permission' }),
    step({ stepId: 'o1', runId: 'r5', failed: true }),
  ];

  it('counts failed steps and runs per bucket, and lists the corrected runs as the agent-method bucket', () => {
    const buckets = attribute(steps, ['r1', 'r9']);
    const byName = Object.fromEntries(buckets.map((bucket) => [bucket.bucket, bucket]));
    expect(byName['fix_list']).toMatchObject({ failedSteps: 2, runs: 2, exampleStepIds: ['v1', 'h1'] });
    expect(byName['transient']).toMatchObject({ failedSteps: 1, runs: 1 });
    expect(byName['policy']).toMatchObject({ failedSteps: 1, runs: 1 });
    expect(byName['unclassified']).toMatchObject({ failedSteps: 1, runs: 1 });
    expect(byName['agent_method']).toMatchObject({ failedSteps: 0, runs: 2, exampleRunIds: ['r1', 'r9'] });
  });
});
