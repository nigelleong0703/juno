/** PH9 oversized-output artifacts: a large result is retained privately and paged back through the
 * registered output_read tool. The pipeline test drives the REAL run-tools path (policy → durable
 * never-replay fence → capture-before-projection → transcript), so the private body is provably
 * absent from the transcript and the step rows, and every claim is asserted on real output. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, Tool, ToolContext, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { CANCELLED, NEVER_CANCELLED } from '../../../execution/harness/services/cancel.js';
import { executeSingleToolCall } from '../../../execution/harness/services/run-tools.js';
import { captureOversizedResult } from '../../../execution/harness/services/output-capture.js';
import type { ToolCallContext } from '../../../execution/harness/services/tool-policy.js';
import type { RunInput, RunServices } from '../../../execution/harness/services/run-types.js';
import { ScriptedModel } from '../../../execution/harness/testing/stubs.js';
import { boundedSummary, projectResult, redactText } from '../../../execution/harness/services/tool-projection.js';
import { createToolRegistry } from '../index.js';
import { ARTIFACT_CHAR_CAP, artifactNotice, captureOutputArtifact, capturePrivateDetails } from '../outputArtifacts.js';
import { cleanupExpiredArtifacts, readOutputArtifact } from '../outputArtifactReads.js';
import { NoopEnqueuer } from './codingFixtures.js';

const OWNER = 'owner-1';
const AGENT = 'agent-a';
const CONV = 'conv-1';
const AT = '2026-10-08T00:00:00.000Z';

const wake = {
  id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT,
} as WakeEvent;

function ctx(store: Store, agentId = AGENT, ownerId = OWNER): ToolContext {
  return { ownerId, agentId, conversationId: CONV, runId: 'run-1', store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

/** The page body: output_read puts the delivered text in the first block and its notes after it. */
function pageOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  return block !== undefined && block.type === 'text' ? (block.text ?? '') : '';
}

async function registry(store: Store): Promise<ToolRegistry> {
  return createToolRegistry({ store, enqueuer: new NoopEnqueuer() });
}

/** Page an artifact to the end through the registered tool, exactly as the model would. */
async function readAll(tools: ToolRegistry, store: Store, ref: string, maxChars: number): Promise<string> {
  const tool = tools.get('output_read');
  if (tool === undefined) throw new Error('output_read is not registered');
  let collected = '';
  let cursor = 0;
  for (let page = 0; page < 200; page += 1) {
    const result = await tool.execute({ ref, cursor, maxChars }, ctx(store));
    collected += pageOf(result);
    const details = result.details ?? {};
    if (details.nextCursor === undefined || Number(details.nextCursor) >= Number(details.totalChars)) break;
    cursor = Number(details.nextCursor);
  }
  return collected;
}

/** A journaling tool-call context with a stable step id, so a replay resolves the same step. */
function testContext(): ToolCallContext {
  const journal = new Map<string, unknown>();
  let next = 0;
  return {
    rand: { uuidv4: () => (next++ === 0 ? 's1' : 's1') },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
  };
}

function oversizedTool(name: string, text: string, counter: { runs: number }): Tool {
  return {
    name, description: name, parameters: {}, replay: 'never', sideEffect: true,
    execute: async (): Promise<ToolResult> => { counter.runs += 1; return { content: [{ type: 'text', text }] }; },
  };
}

async function seedRun(store: Store): Promise<void> {
  // The owner's agent and direct chat: who is present is read from them (batch 5b), and the owner alone is the default.
  await store.put('agents', { id: AGENT, ownerId: OWNER, name: 'Agent' } as never);
  await store.put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT] } as never);
  await store.put('runs', {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 't', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
}

describe('oversized tool output artifacts', () => {
  it('pages astral characters losslessly and rejects a cursor inside a pair', async () => {
    const store = createMemoryStore();
    const text = '😀'.repeat(40) + 'end';
    const captured = await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-2', stepId: 'step-1', tool: 'mcp.echo', text });
    const tools = await registry(store);
    const reconstructed = await readAll(tools, store, captured.ref, 3);
    expect(reconstructed).toBe(text);
    expect(reconstructed).not.toContain('\uFFFD');
    // Cursor 1 sits on the first emoji's low surrogate: rejected, never skipped or duplicated.
    expect(await readOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, ref: captured.ref, cursor: 1 })).toBe('bad_cursor');
    const bad = await tools.get('output_read')?.execute({ ref: captured.ref, cursor: 1 }, ctx(store));
    expect(bad?.isError).toBe(true);
    expect(bad?.details).toMatchObject({ artifact: 'bad_cursor' });
  });

  it('allows a same-agent read from another run but denies another owner, agent or binding', async () => {
    const store = createMemoryStore();
    const captured = await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-1', stepId: 'step-1', tool: 'shell.run', text: 'shared' });
    const tools = await registry(store);
    const otherRun = await tools.get('output_read')?.execute({ ref: captured.ref }, { ...ctx(store), runId: 'run-999' });
    expect(otherRun?.isError).not.toBe(true);
    expect(pageOf(otherRun ?? { content: [] })).toBe('shared');
    expect(await readOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, ref: captured.ref, runId: 'run-999' })).toBe('denied');
    expect(await readOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, ref: captured.ref, stepId: 'other' })).toBe('denied');
    expect(await readOutputArtifact(store, { ownerId: 'owner-9', agentId: AGENT, ref: captured.ref })).toBe('denied');
    expect(await readOutputArtifact(store, { ownerId: OWNER, agentId: 'agent-b', ref: captured.ref })).toBe('denied');
    expect((await tools.get('output_read')?.execute({ ref: captured.ref }, ctx(store, 'agent-b')))?.isError).toBe(true);
    expect((await tools.get('output_read')?.execute({ ref: 'art_ffffffffffffffffffffffff' }, ctx(store)))?.details).toMatchObject({ artifact: 'not_found' });
  });

  it('reports expiry and deletion truthfully instead of inventing output', async () => {
    const store = createMemoryStore();
    const captured = await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-5', stepId: 'step-1', tool: 'shell.run', text: 'kept' });
    expect(await readOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, ref: captured.ref, now: Date.parse(captured.expiresAt) + 1 })).toBe('expired');
    const tools = await registry(store);
    await store.patch('artifacts', captured.ref, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await tools.get('output_read')?.execute({ ref: captured.ref }, ctx(store));
    expect(expired?.isError).toBe(true);
    expect(expired?.details).toMatchObject({ artifact: 'expired' });
    await store.delete('artifacts', captured.ref);
    expect((await tools.get('output_read')?.execute({ ref: captured.ref }, ctx(store)))?.details).toMatchObject({ artifact: 'not_found' });
  });

  it('caps the stored copy honestly and never splits a pair at the cap', async () => {
    const store = createMemoryStore();
    const captured = await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-6', stepId: 'step-1', tool: 'shell.run', text: 'C'.repeat(ARTIFACT_CHAR_CAP + 10) });
    expect(captured.truncated).toBe(true);
    expect(captured.chars).toBe(ARTIFACT_CHAR_CAP);
    expect(captured.originalChars).toBe(ARTIFACT_CHAR_CAP + 10);
    expect(artifactNotice(captured, 'shell.run')).toContain('itself capped');
    const tools = await registry(store);
    const page = await tools.get('output_read')?.execute({ ref: captured.ref, maxChars: 20_000 }, ctx(store));
    expect(page?.details).toMatchObject({ truncated: true, totalChars: ARTIFACT_CHAR_CAP, originalChars: ARTIFACT_CHAR_CAP + 10 });
    const astral = 'a' + '😀'.repeat(200_000);
    const cappedAstral = await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-6b', stepId: 'step-1', tool: 'shell.run', text: astral });
    expect(cappedAstral.chars).toBe(ARTIFACT_CHAR_CAP - 1);
    const rebuilt = await readAll(tools, store, cappedAstral.ref, 20_000);
    expect(rebuilt).toBe(astral.slice(0, ARTIFACT_CHAR_CAP - 1));
    expect(rebuilt).not.toContain('\uFFFD');
  });

  it('keeps the private body out of the projected result and the step summary, redacted and readable', async () => {
    const store = createMemoryStore();
    const secret = 'Bearer sk-abcdefghijklmnop';
    const full = secret + ':' + 'P'.repeat(120_000);
    const captured = await capturePrivateDetails(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-8', stepId: 'step-1', tool: 'mcp.echo', details: { mcp: true, fullContent: full }, redact: redactText });
    expect(captured.details).not.toHaveProperty('fullContent');
    const projected = projectResult({ content: [{ type: 'text', text: artifactNotice({ ref: String(captured.artifactRef), chars: 0, bytes: 0, originalChars: 0, truncated: false, expiresAt: '' }, 'mcp.echo') }], details: captured.details });
    expect(projected.details).not.toHaveProperty('fullContent');
    expect(JSON.stringify(projected.content)).not.toContain('PPPP');
    expect(boundedSummary(projected)).not.toContain('PPPP');
    expect(boundedSummary(projected)).not.toContain('sk-abcdefghijklmnop');
    const tools = await registry(store);
    const text = await readAll(tools, store, String(captured.artifactRef), 20_000);
    expect(text).toBe(redactText(full));
    expect(text).not.toContain('sk-abcdefghijklmnop');
  });

  it('scans oldest-first with bounded continuation and never deletes live or foreign rows', async () => {
    const store = createMemoryStore();
    // The expired row is created FIRST, so it is the oldest and the oldest-first scan reaches it even
    // with 500 newer live rows in front of the page limit.
    const old = await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-old', stepId: 's', tool: 'shell.run', text: 'old' });
    const live: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      live.push((await captureOutputArtifact(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-live-' + String(index), stepId: 's', tool: 'shell.run', text: 'live' })).ref);
    }
    const foreign = await captureOutputArtifact(store, { ownerId: 'owner-9', agentId: AGENT, runId: 'run-foreign', stepId: 's', tool: 'shell.run', text: 'foreign' });
    const past = new Date(Date.now() - 1000).toISOString();
    // Rows made in the same millisecond tie on time and then order by id (as in Postgres), so "created first" is made
    // explicit: the expired row is an hour older than the live ones.
    await store.patch('artifacts', old.ref, { expiresAt: past, createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    await store.patch('artifacts', foreign.ref, { expiresAt: past });
    const first = await cleanupExpiredArtifacts(store, { ownerId: OWNER, limit: 100 });
    expect(first.deleted).toBe(1);
    expect(first.scanned).toBe(100);
    expect(first.nextCursor).toBeDefined();
    expect(await store.get('artifacts', old.ref)).toBeNull();
    expect(await store.get('artifacts', foreign.ref)).not.toBeNull();
    expect(await store.get('artifacts', live[0] ?? '')).not.toBeNull();
    expect(await store.get('artifacts', live[499] ?? '')).not.toBeNull();
  });

  it('retains a large one-shot result through the real run-tools path and never re-runs the effect', async () => {
    const store = createMemoryStore();
    const big = 'HEAD-' + 'Z'.repeat(150_000) + '-TAIL-SECRET';
    const counter = { runs: 0 };
    const tool = oversizedTool('shell.run', big, counter);
    const services: RunServices = {
      store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(),
      toolRegistry: { forAgent: async () => [tool], get: (name) => (name === 'shell.run' ? tool : undefined) },
    };
    await seedRun(store);
    const runInput: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };
    const call = { id: 'call-1', name: 'shell.run', arguments: {} };
    const ctx0 = testContext();
    const first = await executeSingleToolCall(ctx0, services, runInput, 'run-1', 0, 0, call, NEVER_CANCELLED, []);
    expect(first).not.toBe(CANCELLED);
    const result = (first as { result: ToolResult }).result;
    const ref = String(result.details?.artifactRef);
    expect(ref).toMatch(/^art_[0-9a-f]{24}$/);
    expect(result.details).not.toHaveProperty('fullContent');
    expect(JSON.stringify(result.content)).toContain('artifact ' + ref);
    expect(counter.runs).toBe(1);
    // The transcript and the step rows carry the notice and a bounded head, never the full body.
    expect(JSON.stringify((await store.list('transcripts', { limit: 10 })).items)).not.toContain('TAIL-SECRET');
    expect(JSON.stringify((await store.list('steps', { limit: 10 })).items)).not.toContain('TAIL-SECRET');
    // Replay of the same call: the fence returns the cached result and the effect never re-runs.
    const replay = await executeSingleToolCall(ctx0, services, runInput, 'run-1', 0, 0, call, NEVER_CANCELLED, []);
    expect(counter.runs).toBe(1);
    expect((replay as { result: ToolResult }).result.details?.artifactRef).toBe(ref);
    expect((await store.list('artifacts')).items).toHaveLength(1);
    const tools = await registry(store);
    expect(await readAll(tools, store, ref, 20_000)).toBe(big);
  });

  it('writes no artifact when the run was cancelled before the capture', async () => {
    const store = createMemoryStore();
    const controller = new AbortController();
    controller.abort(new Error('run stopped'));
    const result: ToolResult = { content: [{ type: 'text', text: 'Z'.repeat(200_000) }] };
    // The exact function the guarded action calls: an aborted run leaves the result untouched.
    const kept = await captureOversizedResult(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-9', stepId: 'step-1', tool: 'shell.run' }, result, controller.signal);
    expect(kept).toBe(result);
    expect((await store.list('artifacts')).items).toHaveLength(0);
  });

  it('keeps an image block that follows an oversized text body', async () => {
    const store = createMemoryStore();
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'png-data' };
    const result: ToolResult = { content: [{ type: 'text', text: 'Z'.repeat(200_000) }, image] };
    const captured = await captureOversizedResult(store, { ownerId: OWNER, agentId: AGENT, runId: 'run-img', stepId: 'step-1', tool: 'computer.screenshot' }, result);
    expect(captured.content.some((block) => block.type === 'image')).toBe(true);
    expect(JSON.stringify(captured.content[0])).toContain('result retained as artifact');
  });
});
