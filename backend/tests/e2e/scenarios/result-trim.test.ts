import { describe, expect, it } from 'vitest';
import { listenEvents, modelRequests, queryStack, scriptedChat, toolCall } from '../harness/client';
import { setupConnector, stubConnector, type StubTool } from '../harness/mcp-fixture';

/**
 * BACKEND §3.5.2b: thirty fetched pages in one run. The stack's scripted context window is small (24,000 tokens, of which the frozen system
 * prompt takes about a quarter), so each page is just over the 2,000-character floor and untrimmed the results would force a summary
 * compaction around the twenty-eighth fetch. Instead the old results are shown as stubs at a few epoch boundaries (past 60% of the
 * compaction trigger), the request shrinks there, and everything else stays append-only: the system row, the tool list and every earlier
 * message are the same in every request except at the boundaries. (A connector's answer is capped at 20,000 characters by the MCP client and
 * never has a retained artifact, so every stub here keeps the head of its page; the artifact form of the stub is covered by the unit test.)
 */
const PAGES = 30;
const PAGE_CHARS = 2_050;
const page = (n: number): string => ('Page ' + String(n) + '. ' + 'The quick brown fox jumps over the lazy dog. '.repeat(60)).slice(0, PAGE_CHARS);

const fetchTool: StubTool = {
  name: 'fetch_page', description: 'Fetch a web page.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  annotations: { readOnlyHint: true },
  answer: (args) => ({ result: { content: [{ type: 'text', text: page(Number(String(args['url']).split('/').at(-1))) }] } }),
};

describe('thirty large fetch results in one run', () => {
  it('shrinks the request at a few epoch boundaries, keeps the stable prefix, and never needs a summary', async () => {
    const connector = await stubConnector([fetchTool]);
    const { account, agentId } = await setupConnector('result-trim', connector);
    const events = await listenEvents(account.cookie);
    try {
      const text = 'Read all thirty pages and tell me what they have in common.';
      const turns = Array.from({ length: PAGES }, (_, i) => ({ matchLastText: text, step: i, toolCalls: [toolCall('f' + String(i), 'linear_fetch_page', { url: 'https://pages.test/' + String(i + 1) })] }));
      const { conversationId, sessionKey } = await scriptedChat(account, agentId, [...turns, { matchLastText: text, step: PAGES, text: 'They are all about a quick brown fox.' }], text);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 120_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      expect(connector.calls).toHaveLength(PAGES);

      // The boundaries are checkpoint rows with stubs and no summary; no real compaction was needed.
      const rows = await queryStack('SELECT doc FROM compactions WHERE kind = ? ORDER BY (doc->>\'epoch\')::int', [sessionKey]);
      const checkpoints = rows.map((row) => row['doc'] as { summary?: string; trims?: Array<{ seq: number; stub: string }> });
      expect(checkpoints.length, 'at least one trim boundary').toBeGreaterThanOrEqual(1);
      expect(checkpoints.every((checkpoint) => checkpoint.summary === undefined && (checkpoint.trims?.length ?? 0) > 0), 'no summary compaction').toBe(true);
      const stubs = checkpoints.at(-1)?.trims ?? [];
      expect(stubs[0]?.stub).toContain('linear_fetch_page https://pages.test/1 (');
      expect(stubs[0]?.stub, 'no retained output: the head of the page stays').toContain('Page 1. The quick brown fox');

      // Prompt size before and after: what the 30 results would add up to untrimmed against what the last request carried.
      const requests = modelRequests(sessionKey);
      expect(requests).toHaveLength(PAGES + 1);
      const perResult = requests[1]?.toolResultChars ?? 0;
      const untrimmed = PAGES * perResult;
      const last = requests.at(-1);
      const peak = Math.max(...requests.map((request) => request.toolResultChars));
      console.log(`[result-trim] one result carries ${String(perResult)} chars; tool results in the last request: ${String(last?.toolResultChars)} (untrimmed: ${String(untrimmed)}), peak ${String(peak)}; whole prompt ${String(last?.chars)} chars; boundaries ${String(checkpoints.length)}`);
      expect(perResult).toBeGreaterThan(2_000);
      expect(last?.toolResultChars ?? Infinity).toBeLessThan(untrimmed * 0.8);
      expect(peak).toBeLessThan(untrimmed * 0.8);

      // The stable prefix: the tool list and the system row are the same in every request, and a request only differs from the one before by
      // what was appended, except at a boundary (where the earliest stubbed result changes), and there are exactly as many of those as trims.
      expect(new Set(requests.map((request) => JSON.stringify(request.tools))).size).toBe(1);
      expect(new Set(requests.map((request) => request.hashes[0])).size, 'one system row throughout').toBe(1);
      let breaks = 0;
      let drops = 0;
      for (let i = 1; i < requests.length; i += 1) {
        const before = requests[i - 1];
        const now = requests[i];
        if (before === undefined || now === undefined) continue;
        if (!before.hashes.every((hash, at) => now.hashes[at] === hash)) {
          breaks += 1;
          if (now.chars < before.chars) drops += 1;
          console.log(`[result-trim] boundary before request ${String(i + 1)}: prompt ${String(before.chars)} -> ${String(now.chars)} chars (system row ${before.hashes[0] === now.hashes[0] ? 'unchanged' : 'CHANGED'}, ${String(before.hashes.length)} -> ${String(now.hashes.length)} messages)`);
        }
      }
      expect(breaks, 'the history changes only at the trim boundaries').toBe(checkpoints.length);
      expect(drops, 'and each boundary makes the request smaller').toBe(checkpoints.length);
    } finally {
      events.close();
      await connector.close();
    }
  }, 180_000);
});
