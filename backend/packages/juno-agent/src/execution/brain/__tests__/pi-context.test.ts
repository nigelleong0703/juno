import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { contentText } from '@earendil-works/pi-ai';
import { buildProjectedMessages, buildSummaryRequestMessage } from '../pi-context/index.js';
import { estimateCutTokens, findCutPoint } from '../pi-context/cut.js';
import { serializeConversation } from '../pi-context/serialize.js';
import { buildMessages, planCompaction } from '../compaction.js';
import { parseMessage } from '../messages.js';
function userEntry(seq: number, text: string): TranscriptEntry {
  const message: Message = { role: 'user', content: text, timestamp: seq };
  return { id: 'tx' + String(seq), sessionKey: 'a:c', seq, message: { ...message }, compactionEpoch: 0, at: '2026-10-07T00:00:00Z' };
}
function assistantEntry(seq: number, calls: Array<{ id: string; name: string }>): TranscriptEntry {
  const message: Message = {
    role: 'assistant',
    content: calls.map(call => ({ type: 'toolCall', id: call.id, name: call.name, arguments: { path: '/workspace/f' } })),
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: seq,
  };
  return { id: 'tx' + String(seq), sessionKey: 'a:c', seq, message: { ...message }, compactionEpoch: 0, at: '2026-10-07T00:00:00Z' };
}
function resultEntry(seq: number, callId: string, name: string, text: string): TranscriptEntry {
  const message: Message = { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: seq };
  return { id: 'tx' + String(seq), sessionKey: 'a:c', seq, message: { ...message }, compactionEpoch: 0, at: '2026-10-07T00:00:00Z' };
}
function imageUserEntry(seq: number): TranscriptEntry {
  const message: Message = { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], timestamp: seq };
  return { id: 'tx' + String(seq), sessionKey: 'a:c', seq, message: { ...message }, compactionEpoch: 0, at: '2026-10-07T00:00:00Z' };
}
function roleOf(entry: TranscriptEntry | undefined): string {
  if (entry === undefined) return '';
  const raw = entry.message;
  if (typeof raw !== 'object' || raw === null) return '';
  const role = Reflect.get(raw, 'role');
  return typeof role === 'string' ? role : '';
}
function parseLenient(entry: TranscriptEntry): Message | undefined {
  try {
    return parseMessage(entry.message);
  } catch {
    return undefined;
  }
}
describe('pi-context single-turn cut and projection', () => {
  it('cuts inside one long user plus tool turn without orphan tool results', () => {
    const entries: TranscriptEntry[] = [userEntry(0, 'Please keep working.')];
    let seq = 1;
    for (let i = 0; i < 10; i++) {
      entries.push(assistantEntry(seq, [{ id: 'call' + String(i), name: 'read' }]));
      seq += 1;
      entries.push(resultEntry(seq, 'call' + String(i), 'read', 'history '.repeat(300)));
      seq += 1;
    }
    const cut = findCutPoint(entries, 0, entries.length, 1000);
    expect(cut.isSplitTurn).toBe(true);
    const plan = planCompaction(entries, 1000);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.older.length).toBeGreaterThan(0);
    expect(plan.kept.length).toBeGreaterThan(0);
    expect(roleOf(plan.kept[0])).not.toBe('toolResult');
    const keptCalls = new Set<string>();
    for (const entry of plan.kept) {
      const parsed = parseLenient(entry);
      if (parsed !== undefined && parsed.role === 'assistant') {
        for (const block of parsed.content) {
          if (block.type === 'toolCall') keptCalls.add(block.id);
        }
      }
    }
    for (const entry of plan.kept) {
      const parsed = parseLenient(entry);
      if (parsed !== undefined && parsed.role === 'toolResult') {
        expect(keptCalls.has(parsed.toolCallId)).toBe(true);
      }
    }
    expect(JSON.stringify(plan.older.map(entry => entry.message))).toContain('Please keep working.');
  });
  it('keeps multiple tool calls and their results together', () => {
    const entries: TranscriptEntry[] = [userEntry(0, 'read two files')];
    entries.push(assistantEntry(1, [{ id: 'a', name: 'read' }, { id: 'b', name: 'read' }]));
    entries.push(resultEntry(2, 'a', 'read', 'first file body'));
    entries.push(resultEntry(3, 'b', 'read', 'second file body'));
    const plan = planCompaction(entries, 10);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(roleOf(plan.kept[0])).not.toBe('toolResult');
    expect(JSON.stringify(plan.kept.map(entry => entry.message))).toContain('second file body');
  });
  it('counts image blocks and serializes them without crashing', () => {
    const textOnly: Message = { role: 'user', content: 'look at this', timestamp: 1 };
    const withImage: Message = { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], timestamp: 2 };
    expect(estimateCutTokens(withImage)).toBeGreaterThan(estimateCutTokens(textOnly));
    const text = serializeConversation([withImage]);
    expect(text).toContain('look at this');
    expect(text).toContain('image');
    const parsed = parseLenient(imageUserEntry(0));
    expect(parsed).not.toBeUndefined();
    if (parsed === undefined) return;
    expect(serializeConversation([parsed]).length).toBeGreaterThan(0);
  });
  it('folds a prior summary exactly once', () => {
    const older: TranscriptEntry[] = [userEntry(0, 'migrate the queue worker')];
    const first = buildSummaryRequestMessage(older, undefined);
    expect(contentText(first.content, '')).not.toContain('prior checkpoint');
    const second = buildSummaryRequestMessage(older, 'prior checkpoint');
    const body = contentText(second.content, '');
    const hits = body.match(/prior checkpoint/g);
    expect(hits === null ? 0 : hits.length).toBe(1);
    expect(body).toContain('migrate the queue worker');
  });
  it('keeps the current system prompt first and frames the summary as untrusted', () => {
    const system: Message = { role: 'system', content: 'identity-v2', timestamp: 0 };
    const kept: TranscriptEntry[] = [userEntry(5, 'latest question')];
    const projected = buildMessages(system, 'Earlier work', kept);
    expect(projected[0]).toMatchObject({ role: 'system', content: 'identity-v2' });
    const body = JSON.stringify(projected);
    const hits = body.match(/Earlier work/g);
    expect(hits === null ? 0 : hits.length).toBe(1);
    expect(body).toContain('<untrusted>');
    const direct = buildProjectedMessages(system, 'Earlier work', kept);
    expect(direct.length).toBe(3);
  });
  it('throws on malformed persisted rows instead of quietly dropping history', () => {
    const system: Message = { role: 'system', content: 'identity', timestamp: 0 };
    const bad: TranscriptEntry = { id: 'bad', sessionKey: 'a:c', seq: 9, message: { role: 'assistant', content: 'broken' }, compactionEpoch: 0, at: '2026-10-07T00:00:00Z' };
    expect(() => buildProjectedMessages(system, 'Earlier work', [bad])).toThrow();
  });
});
