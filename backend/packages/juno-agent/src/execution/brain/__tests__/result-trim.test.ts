import { describe, expect, it } from 'vitest';
import type { BrainContext, Compaction, TranscriptEntry } from '../../../contracts/index.js';
import { createCompaction, createTrim } from '../compaction.js';
import { trimDue } from '../compaction-metrics.js';
import { projectMessages } from '../context.js';
import { KEEP_TURNS, MIN_RESULT_CHARS, applyTrims, planTrim, stubFor } from '../result-trim.js';

let seq = 0;
const entry = (message: Record<string, unknown>): TranscriptEntry => {
  seq += 1;
  return { id: 'tx' + String(seq), sessionKey: 's', seq, message, compactionEpoch: 0, at: '2026-11-01T10:00:00.000Z' };
};
const SYSTEM = (): TranscriptEntry => entry({ role: 'system', content: 'rules', timestamp: 1 });
const user = (text: string) => entry({ role: 'user', content: text, timestamp: 1 });
const call = (id: string, name: string, args: Record<string, unknown>) => entry({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], timestamp: 1, api: 'x', provider: 'x', model: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse' });
const result = (id: string, name: string, text: string, extra: Record<string, unknown> = {}) => entry({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: 1, ...extra });
const BIG = 'x'.repeat(MIN_RESULT_CHARS + 500);

/** A user message, then `n` tool calls with their results; each result is `BIG` unless `texts` says otherwise. */
function chat(n: number, texts: Record<number, string> = {}): TranscriptEntry[] {
  const rows: TranscriptEntry[] = [user('look these up')];
  for (let i = 1; i <= n; i += 1) {
    rows.push(call('c' + String(i), 'web_fetch', { url: 'https://example.com/page' + String(i) }), result('c' + String(i), 'web_fetch', texts[i] ?? BIG));
  }
  return rows;
}

describe('which results become stubs', () => {
  it('only the large plain-text ones older than the last turns, and each stub names the tool and its target', () => {
    const rows = chat(KEEP_TURNS + 3, { 2: 'small', 3: 'ok' });
    const plan = planTrim(rows, new Set());
    // 11 calls: the last 8 assistant turns stay whole; of the 3 older results, #2 and #3 are small.
    expect(plan.trims).toHaveLength(1);
    expect(plan.trims[0]?.stub).toContain('web_fetch https://example.com/page1');
    expect(plan.trims[0]?.stub).toContain(String(BIG.length) + ' characters');
    expect(plan.reclaimedTokens).toBeGreaterThan(0);
  });

  it('points at the retained artifact when there is one, and keeps the start of the text when there is none', () => {
    const retained = '[result retained as artifact art_0123 (120000 characters from web_fetch); too large to deliver in full. Read it with output_read { ref: "art_0123", cursor: 0 }.]\n' + 'y'.repeat(3000);
    expect(stubFor('web_fetch', 'https://a.test/x', retained)).toBe('[Earlier result trimmed to keep this conversation fast: web_fetch https://a.test/x (' + String(retained.length) + ' characters). Read it again with output_read { ref: "art_0123", cursor: 0 }.]');
    const plain = 'z'.repeat(5000);
    const stub = stubFor('shell.run', 'ls -la', plain);
    expect(stub.startsWith('z'.repeat(1000) + '\n[Earlier result trimmed')).toBe(true);
    expect(stub.length).toBeLessThan(1300);
  });

  it('leaves results with images, loaded tools and earlier stubs alone, and sees through the tool_call proxy', () => {
    const rows = [
      user('go'),
      call('a', 'tool_call', { name: 'files.read', arguments: { path: '/workspace/notes.md' } }),
      result('a', 'tool_call', BIG),
      call('b', 'computer_screenshot', {}),
      entry({ role: 'toolResult', toolCallId: 'b', toolName: 'computer_screenshot', content: [{ type: 'text', text: BIG }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }], isError: false, timestamp: 1 }),
      call('c', 'tool_search', {}),
      result('c', 'tool_search', BIG, { loadedTools: ['x'] }),
      ...chat(KEEP_TURNS).slice(1),
    ];
    const plan = planTrim(rows, new Set());
    expect(plan.trims.map((trim) => trim.seq)).toEqual([rows[2]?.seq]);
    expect(plan.trims[0]?.stub).toContain('files.read /workspace/notes.md');
    expect(planTrim(rows, new Set([rows[2]?.seq ?? 0])).trims).toEqual([]);
  });

  it('gives nothing back while the last turns are all there is', () => {
    expect(planTrim(chat(KEEP_TURNS), new Set()).trims).toEqual([]);
  });
});

describe('the projection after a trim', () => {
  it('shows the stubs, keeps the system row and every message before and after them, and is the same every time', () => {
    const rows = [SYSTEM(), ...chat(KEEP_TURNS + 2)];
    const plan = planTrim(rows.slice(1), new Set());
    const checkpoint: Compaction = createTrim('s', 1, null, plan.trims);
    const before = projectMessages(rows, null, true);
    const after = projectMessages(rows, checkpoint, true);
    expect(after).toHaveLength(before.length);
    expect(after[0]).toEqual(before[0]);
    expect(JSON.stringify(projectMessages(rows, checkpoint, true))).toBe(JSON.stringify(after.map((message) => message)));
    const stubbed = after.filter((message) => message.role === 'toolResult' && JSON.stringify(message.content).includes('Earlier result trimmed'));
    expect(stubbed).toHaveLength(2);
    // Results from the last turns, and everything that is not a result, are byte for byte what they were.
    expect(JSON.stringify(after.slice(-(KEEP_TURNS * 2)))).toBe(JSON.stringify(before.slice(-(KEEP_TURNS * 2))));
    expect(applyTrims(rows, undefined)).toBe(rows);
  });

  it('a later compaction keeps the stubs of the rows it keeps and drops the ones it summarizes', () => {
    const trims = [{ seq: 3, stub: 'a' }, { seq: 20, stub: 'b' }];
    expect(createCompaction('s', 2, 'summary', 10, undefined, trims).trims).toEqual([{ seq: 20, stub: 'b' }]);
    expect(createCompaction('s', 2, 'summary', 30, undefined, trims).trims).toBeUndefined();
    const carried = createTrim('s', 3, createCompaction('s', 2, 'summary', 10, ['hello'], trims), [{ seq: 25, stub: 'c' }]);
    expect(carried).toMatchObject({ summary: 'summary', uptoSeq: 10, recentUsers: ['hello'], trims: [{ seq: 20 }, { seq: 25 }] });
    expect(createTrim('s', 1, null, []).summary).toBeUndefined();
  });
});

describe('when a trim is due', () => {
  const context = (tokens: number, extra: Record<string, unknown> = {}): BrainContext => ({ sessionKey: 's', agentId: 'a', contextWindow: 100_000, contextTokens: tokens, ...extra });
  it('past 60% of the compaction trigger and not at it, and again only after the context has grown by a step', () => {
    // The trigger is 80% of the window: 80,000 tokens.
    expect(trimDue(context(40_000))).toBe(false);
    expect(trimDue(context(50_000))).toBe(true);
    expect(trimDue(context(85_000))).toBe(false);
    expect(trimDue(context(50_000, { trimBase: 0.55 }))).toBe(false);
    expect(trimDue(context(60_000, { trimBase: 0.55 }))).toBe(true);
    expect(trimDue({ sessionKey: 's', agentId: 'a', contextTokens: 50_000 })).toBe(false);
  });
});
