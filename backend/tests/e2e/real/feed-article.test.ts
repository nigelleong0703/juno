import { aguiInput } from '../../agui-input.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, stackUrls, toolActivity } from '../harness/client';

interface Post { id: string; title: string; summary: string; body?: string; imageUrl?: string }

describe('real model: illustrated Feed article', () => {
  it('delegates research, reads the article skill and publishes sourced images between prose sections', async () => {
    const account = await createAccount('feed-article');
    const agent = await defaultAgent(account);
    const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
    expect(chat.status).toBe(201);
    const conversationId: string = chat.body.id;
    const events = await listenEvents(account.cookie);
    const sql = postgres(stackUrls().databaseUrl, { max: 1 });
    const evidenceDir = resolve('../../.data/feed-article-live');
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text: '帮我研究过去两周 AI 领域的重要发布，挑两三个值得讲清楚的，发到 Feed 给我一篇完整的中文图文文章。我要正文段落之间穿插相关图片、图注和来源，不只是封面缩略图。请查原文，说明日期、具体变化和意义，来源链接直接放在对应段落里。',
      }));
      expect(sent.status).toBe(202);
      await events.waitFor(event => event.data.type === 'feed.created', 540_000);
      const linked = await events.waitFor(event => event.data.type === 'item.added' && event.data.item.type === 'feed_ref' && event.data.item.conversationId === conversationId, 30_000);
      expect(linked.data.item.feedPostId, 'requested article has a clickable chat entry after asynchronous completion').toBeTruthy();
      const response = await account.api('GET', '/v1/feed');
      const posts: Post[] = response.body.items;
      const sessions = await sql<Array<{ key: string }>>`SELECT DISTINCT doc->>'sessionKey' AS key FROM transcripts WHERE owner_id=${account.userId}`;
      const activities = await Promise.all(sessions.map(row => toolActivity(row.key)));
      const calls = activities.flatMap(activity => activity.calls);
      const results = activities.flatMap(activity => activity.results);
      writeFileSync(resolve(evidenceDir, 'result.json'), JSON.stringify({ posts, calls, results }, null, 2));
      expect(calls.some(call => call.name === 'child_spawn' || (call.name === 'tool_call' && call.arguments['name'] === 'child_spawn')), 'substantive research is delegated').toBe(true);
      expect(calls.some(call => call.name === 'skill_read' && call.arguments['name'] === 'feed-article'), 'execution reads the production skill').toBe(true);
      expect(results.some(result => result.toolName === 'web_fetch' && !result.isError), 'sources are opened').toBe(true);
      const imageTurns = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM transcripts WHERE owner_id=${account.userId} AND jsonb_path_exists(doc, '$.message.content[*] ? (@.type == "image")')`;
      expect(Number(imageTurns[0]?.count ?? 0), 'pictures are actually shown to the vision-capable execution model').toBeGreaterThanOrEqual(2);
      expect(posts).toHaveLength(1);
      const body = posts[0]?.body ?? '';
      const images = [...body.matchAll(/!\[[^\]]+\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/g)];
      expect(images.length, 'article has multiple inline images, not just thumbnail').toBeGreaterThanOrEqual(2);
      for (const [index, image] of images.entries()) {
        const url = image[1];
        expect(url, 'client sees signed cached media URL').toContain('/v1/media/');
        const delivered = await fetch(url ?? '', { signal: AbortSignal.timeout(30_000) });
        expect(delivered.status, 'article image downloads through production gateway').toBe(200);
        expect(delivered.headers.get('content-type')).toMatch(/^image\//);
        writeFileSync(resolve(evidenceDir, `inline-${index}.png`), Buffer.from(await delivered.arrayBuffer()));
      }
      const first = images[0];
      expect(first?.index).toBeGreaterThan(50);
      expect(body.slice((first?.index ?? 0) + (first?.[0].length ?? 0)).length, 'prose continues after a picture').toBeGreaterThan(100);
      expect([...body.matchAll(/(?<!!)\[[^\]]+\]\(https:\/\/[^)]+\)/g)].length, 'standalone source links').toBeGreaterThanOrEqual(2);
      expect(body).not.toMatch(/(?:链接|来源).{0,8}(?:见聊天|在聊天)/);
    } catch (error) {
      const sessions = await sql<Array<{ key: string }>>`SELECT DISTINCT doc->>'sessionKey' AS key FROM transcripts WHERE owner_id=${account.userId}`;
      const activities = await Promise.all(sessions.map(row => toolActivity(row.key)));
      const runs = await sql<Array<{ doc: unknown }>>`SELECT doc FROM runs WHERE owner_id=${account.userId} ORDER BY created_at`;
      writeFileSync(resolve(evidenceDir, 'failure.json'), JSON.stringify({ error: String(error), activities, runs }, null, 2));
      throw error;
    } finally {
      events.close();
      await sql.end();
    }
  }, 600_000);

  it('keeps conversation local and delegates a new small app without a topic-specific rule', async () => {
    const account = await createAccount('generic-routing');
    const agent = await defaultAgent(account);
    const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
    expect(chat.status).toBe(201);
    const conversationId: string = chat.body.id;
    const sessionKey = `${agent.id}:${conversationId}`;
    const events = await listenEvents(account.cookie);
    try {
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: '用一句话解释粤语是什么。' }))).status).toBe(202);
      await events.waitFor(event => event.data.type === 'RUN_FINISHED' && event.data.metadata.juno.run.conversationId === conversationId && !event.data.metadata.juno.run.parentRunId, 90_000);
      const conversation = await toolActivity(sessionKey);
      expect(conversation.calls.some(call => call.name === 'child_spawn'), 'a simple explanation stays with the main agent').toBe(false);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: '帮我做个学粤语的小程序，能翻单词卡、听发音和做小测验，做好给我打开。' }))).status).toBe(202);
      await events.waitFor(event => event.data.type === 'RUN_STARTED' && event.data.metadata.juno.run.conversationId === conversationId && Boolean(event.data.metadata.juno.run.parentRunId), 120_000);
      const creation = await toolActivity(sessionKey);
      const spawnIndex = creation.calls.findIndex(call => call.name === 'child_spawn');
      expect(spawnIndex, 'creating a deliverable is delegated without a Feed-specific trigger').toBeGreaterThanOrEqual(0);
      const beforeSpawn = creation.calls.slice(conversation.calls.length, spawnIndex);
      expect(beforeSpawn.some(call => /^(files[.]write|shell[.]|artifact_publish)/.test(call.name)), 'main does not start implementation before handoff').toBe(false);
    } finally {
      await account.api('POST', `/v1/agents/${agent.id}/stop`);
      events.close();
    }
  }, 240_000);

});
