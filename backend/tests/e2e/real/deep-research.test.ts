import { aguiInput } from '../../agui-input.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, stackUrls, toolActivity, transcriptMessages, waitForIdle } from '../harness/client';

/**
 * Real model, live web (E2E_SEARCH_PROVIDER + E2E_SEARCH_API_KEY): the research skills change how much the agent actually reads.
 * Counts are recorded to .data/deep-research/<case>.json for the report; the assertions are loose on purpose (behaviour, not wording).
 * The old run on the server (2026-11-02): one chat search for the question, then 4 web_search + ~5 web_fetch in a subagent for the report.
 */
const live = process.env['E2E_SEARCH_PROVIDER'] && process.env['E2E_SEARCH_API_KEY'] ? describe : describe.skip;

/** Every id or phrase that belongs to the machinery and must never reach the person. */
const INTERNAL = ['web_search', 'web_fetch', 'feed_post', 'send_message', 'subagent', 'skill_read', 'skill_search', 'tool_call', 'feed-article', 'deep-research', 'deep-search', 'title+summary+body', 'title + summary + body'];

const evidenceDir = resolve('../../.data/deep-research');

interface Counts { webSearch: number; webFetch: number; imageFetches: number; subagents: number; domains: string[]; primary: string[]; fetched: string[] }

const IMAGE_HOSTS = new Set(['image.cnbcfm.com', 'i.insider.com', 'dims.apnews.com']);
function isImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(parsed.pathname) || IMAGE_HOSTS.has(parsed.hostname.replace(/^www\./, ''));
  } catch { return false; }
}
/** A company's own investor pages, SEC filings, earnings releases and call transcripts: what a thorough analyst opens first. */
function isPrimarySource(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, '');
    return /(^|\.)sec\.gov$/.test(host) || /^(ir|investor|investors|investor-relations|press|newsroom)\./.test(host) || /(^|\.)(businesswire|prnewswire|globenewswire)\.com$/.test(host)
      || /\/(investor|investors|investor-relations|press-release|press-releases|earnings|quarterly-results)(\/|$)/i.test(pathname) || /(^|\.)(federalreserve|bls|bea)\.gov$/.test(host);
  } catch { return false; }
}

async function countsFor(ownerId: string): Promise<Counts> {
  const sql = postgres(stackUrls().databaseUrl, { max: 1 });
  try {
    const sessions = await sql<Array<{ key: string }>>`SELECT DISTINCT doc->>'sessionKey' AS key FROM transcripts WHERE owner_id=${ownerId}`;
    const calls = (await Promise.all(sessions.map(row => toolActivity(row.key)))).flatMap(activity => activity.calls);
    const unwrapped = calls.map(call => call.name === 'tool_call'
      ? { name: String(call.arguments['name']), args: (typeof call.arguments['arguments'] === 'object' && call.arguments['arguments'] !== null ? call.arguments['arguments'] : {}) as Record<string, unknown> }
      : { name: call.name, args: call.arguments });
    const allFetched = unwrapped.filter(call => call.name === 'web_fetch' && typeof call.args['url'] === 'string').map(call => String(call.args['url']));
    // Looking at a picture is a fetch too, but it is not a source: only pages count.
    const fetched = allFetched.filter(url => !isImageUrl(url));
    const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
    const domains = [...new Set(fetched.map(hostOf))];
    const primary = [...new Set(fetched.filter(isPrimarySource))];
    return { webSearch: unwrapped.filter(call => call.name === 'web_search').length, webFetch: fetched.length, imageFetches: allFetched.length - fetched.length, subagents: unwrapped.filter(call => call.name === 'subagent_start').length, domains, primary, fetched };
  } finally {
    await sql.end();
  }
}

/** The text the person saw from the agent after `skip` transcript messages: plain text parts and send_message text. */
async function spokenAfter(sessionKey: string, skip: number): Promise<string> {
  const out: string[] = [];
  for (const message of (await transcriptMessages(sessionKey)).slice(skip)) {
    if (message.role !== 'assistant') continue;
    const parts = JSON.parse(message.text) as Array<Record<string, unknown>>;
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part['type'] === 'text') out.push(String(part['text']));
      if (part['type'] === 'toolCall' && part['name'] === 'send_message') out.push(JSON.stringify((part['arguments'] as Record<string, unknown>)['text'] ?? '') + JSON.stringify((part['arguments'] as Record<string, unknown>)['messages'] ?? ''));
    }
  }
  return out.join('\n');
}

async function chat(prefix: string) {
  const account = await createAccount(prefix);
  const agent = await defaultAgent(account);
  const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
  expect(created.status).toBe(201);
  const conversationId: string = created.body.id;
  const events = await listenEvents(account.cookie);
  const say = async (text: string) => {
    const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
    expect(sent.status).toBe(202);
  };
  return { account, agent, conversationId, events, say, sessionKey: `${agent.id}:${conversationId}` };
}

live('real model: deep research skills', () => {
  mkdirSync(evidenceDir, { recursive: true });

  for (const attempt of [1, 2]) {
    it(`report to the Feed reads many primary sources and covers what an expert expects (run ${attempt}), then never names its internals`, async () => {
      const { account, events, say, conversationId, sessionKey } = await chat('deep-research');
      try {
        await say('帮我做一个这周AI股的详细分析，发到feed');
        await events.waitFor(event => event.data.type === 'feed.created', 1_200_000);
        await waitForIdle(events, conversationId, 120_000);
        const counts = await countsFor(account.userId);
        const post = ((await account.api('GET', '/v1/feed')).body.items as Array<{ title: string; summary: string; body?: string }>)[0];
        const body = post?.body ?? '';
        const skipped = (await transcriptMessages(sessionKey)).length;
        await say('你用了什么skill？feed-article教了你什么？');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await waitForIdle(events, conversationId, 180_000);
        const reply = await spokenAfter(sessionKey, skipped);
        writeFileSync(resolve(evidenceDir, `feed-run-${attempt}.json`), JSON.stringify({ counts, post, reply }, null, 2));
        console.log(`[deep-research feed run ${attempt}]`, JSON.stringify({ webSearch: counts.webSearch, webFetch: counts.webFetch, subagents: counts.subagents, domains: counts.domains.length, primary: counts.primary.length }));
        expect(counts.subagents, 'several research subagents in parallel, not one doing everything').toBeGreaterThanOrEqual(3);
        expect(counts.webFetch, 'a few dozen opened pages (images do not count); run 2 of the first skill opened 14').toBeGreaterThanOrEqual(24);
        expect(counts.domains.length, 'many distinct non-image source domains; run 2 had 8').toBeGreaterThanOrEqual(12);
        expect(counts.primary.length, 'company IR / SEC / earnings-release pages actually opened').toBeGreaterThanOrEqual(4);
        expect(body.length).toBeGreaterThan(1500);
        expect(/\d/.test(body) && /(指引|guidance|展望|预期|预测)/i.test(body), 'figures and guidance').toBe(true);
        expect(/(关注|接下来|下周|风险|watch|risk)/i.test(body), 'what to watch / risks').toBe(true);
        expect(reply.length, 'the follow-up was answered').toBeGreaterThan(5);
        for (const name of INTERNAL) expect(reply.toLowerCase(), `reply must not contain ${name}`).not.toContain(name.toLowerCase());
      } finally {
        events.close();
      }
    }, 1_600_000);
  }

  it('a factual question in the chat is answered from many searches and opened pages, with figures and sources', async () => {
    const { account, events, say, conversationId, sessionKey } = await chat('deep-search');
    try {
      await say('这周AI股怎么样');
      await new Promise(resolve => setTimeout(resolve, 3000));
      await waitForIdle(events, conversationId, 420_000);
      const counts = await countsFor(account.userId);
      const reply = await spokenAfter(sessionKey, 0);
      writeFileSync(resolve(evidenceDir, 'chat-search.json'), JSON.stringify({ counts, reply }, null, 2));
      console.log('[deep-search chat]', JSON.stringify({ webSearch: counts.webSearch, webFetch: counts.webFetch, subagents: counts.subagents, domains: counts.domains.length }));
      expect(counts.webSearch, 'old run: 1 search').toBeGreaterThanOrEqual(3);
      expect(counts.webFetch, 'opens the pages (first skill: 2; now about 6)').toBeGreaterThanOrEqual(5);
      expect(counts.domains.length).toBeGreaterThanOrEqual(4);
      expect(/\d/.test(reply) && /https?:\/\//.test(reply), 'concrete figures with sources').toBe(true);
    } finally {
      events.close();
    }
  }, 600_000);
});
