import { aguiInput } from '../../agui-input.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, listenEvents, scriptedChat, scriptModel, stackUrls, toolCall, transcriptTexts, waitForTranscript } from '../harness/client';

/** The admin token the harness gives the API (harness/stack.ts SECRETS.adminToken). */
const ADMIN_TOKEN = 'e2e-admin-token-0123456789';

/**
 * Apps (BACKEND 10.18) through the real stack: the Apps page lists the chat apps and the catalog, a connection is an installation that
 * every agent may use until the owner changes it, the owner sets one agent's app on or off and its Actions policy, the old connector and
 * per-agent channel routes are gone, the prompt lists only the apps enabled for the agent, and the Connect card says whether an app
 * has to be added or only turned on.
 */
const NOW = '2026-10-26T00:00:00.000Z';

/** A minimal streamable-HTTP MCP server standing in for the mail server: one read tool, one tool that changes things. */
async function fakeMail(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string };
      const reply = (result: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mail', version: '1' } });
      if (message.method === 'tools/list') {
        return reply({ tools: [
          { name: 'search_mail', description: 'Search the mailbox.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
          { name: 'send_mail', description: 'Send an email.', inputSchema: { type: 'object', properties: {} } },
        ] });
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp` };
}

describe('apps', () => {
  let mail: { server: Server; url: string };
  beforeAll(async () => { mail = await fakeMail(); });
  afterAll(async () => { await new Promise<void>((resolve) => mail.server.close(() => resolve())); });

  it('lists the apps, shows an added one with who may use it, sets an agent\'s switch and policy, and has no old route', async () => {
    const account = await createAccount('apps-page');
    const juno = await defaultAgent(account);
    const nova = await account.api('POST', '/v1/agents', { name: 'Nova' });
    expect(nova.status).toBe(201);

    const first = (await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; category: string; installations: unknown[]; enabledAgents: unknown[]; grants: { chatRead: boolean; actions: boolean } }>;
    expect(first.filter((app) => app.category === 'chat').map((app) => app.id)).toEqual(['slack', 'discord', 'telegram', 'feishu']);
    expect(first.find((app) => app.id === 'gmail')).toMatchObject({ category: 'work', installations: [], enabledAgents: [], grants: { chatRead: true, actions: true } });

    // A signed-in Gmail account is an installation every agent may use, asking first before it changes anything.
    const connectionId = 'con-e2e-gmail-' + account.userId.slice(0, 12);
    await insertDocRow('connections', account.userId, { id: connectionId, kind: 'mcp', name: 'Gmail', status: 'connected', enabled: true, catalogId: 'gmail', connectedAt: NOW, endpoint: mail.url, transport: 'http' });
    const appNamed = async (id: string) => ((await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; installations: unknown[]; enabledAgents: unknown[] }>).find((app) => app.id === id);
    const added = await appNamed('gmail');
    expect(added?.installations).toMatchObject([{ id: connectionId, appId: 'gmail', status: 'connected' }]);
    expect(added?.enabledAgents).toHaveLength(2);
    expect(added?.enabledAgents).toEqual(expect.arrayContaining([{ agentId: juno.id, actionsPolicy: 'ask' }, { agentId: nova.body.id, actionsPolicy: 'ask' }]));

    expect((await account.api('PUT', `/v1/agents/${nova.body.id}/apps/gmail`, { enabled: false })).body).toEqual({ agentId: nova.body.id, appId: 'gmail', enabled: false, actionsPolicy: 'ask' });
    expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/gmail`, { enabled: true, actionsPolicy: 'off' })).status).toBe(200);
    expect((await appNamed('gmail'))?.enabledAgents).toEqual([{ agentId: juno.id, actionsPolicy: 'off' }]);
    // Not added, a chat app, a made-up app and a made-up policy are refused.
    expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/notion`, { enabled: true })).status).toBe(409);
    expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/slack`, { enabled: true })).status).toBe(400);
    expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/nope`, { enabled: true })).status).toBe(404);
    expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/gmail`, { enabled: true, actionsPolicy: 'sometimes' })).status).toBe(400);

    // Another account sees none of it, and the routes the Apps page replaced no longer exist.
    const other = await createAccount('apps-other');
    expect(((await other.api('GET', '/v1/apps')).body.items as Array<{ id: string; installations: unknown[] }>).find((app) => app.id === 'gmail')?.installations).toEqual([]);
    expect((await account.api('GET', '/v1/connectors/catalog')).status).toBe(404);
    expect((await account.api('GET', '/v1/connections')).status).toBe(404);
    expect((await account.api('GET', `/v1/agents/${juno.id}/channels`)).status).toBe(404);
    expect((await account.api('POST', `/v1/agents/${juno.id}/channels/telegram`, { botToken: 'x' })).status).toBe(404);
  });

  it('the prompt lists the apps enabled for the agent, and the Connect card says whether an app is not added or only turned off', async () => {
    const account = await createAccount('apps-agent');
    const juno = await defaultAgent(account);
    await insertDocRow('connections', account.userId, { id: 'con-e2e-gmail-' + account.userId.slice(0, 12), kind: 'mcp', name: 'Gmail', status: 'connected', enabled: true, catalogId: 'gmail', connectedAt: NOW, endpoint: mail.url, transport: 'http' });
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await scriptedChat(account, juno.id, [{ text: 'ok' }], 'hello');
      await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes('- Gmail: ')));
      expect((await transcriptTexts(sessionKey)).join('\n')).toContain('(changes ask first)');

      // Gmail is turned off for the agent: asking for it (and Notion, which was never added) puts one card in the chat that says why.
      expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/gmail`, { enabled: false })).status).toBe(200);
      const second = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [juno.id] });
      const secondChat: string = second.body.id;
      scriptModel(`${juno.id}:${secondChat}`, [
        { toolCalls: [toolCall('ask', 'connect_request', { connectors: ['gmail', 'notion'], label: 'Mail and notes' })] },
        { text: 'I asked.' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${secondChat}/runs`, aguiInput(`/v1/conversations/${secondChat}/runs`, { text: 'read my mail' }))).status).toBe(202);
      const card = await events.waitFor((event) => event.data.type === 'request.created' && event.data.request.kind === 'connect' && event.data.request.conversationId === secondChat, 45_000);
      expect(card.data.request.payload).toMatchObject({ appIds: ['gmail', 'notion'], problems: { gmail: 'not_enabled', notion: 'not_added' }, label: 'Mail and notes' });
      expect(conversationId).not.toBe(secondChat);
    } finally {
      events.close();
    }
  });

  it('a Web & video app is added with one call and no sign-in: the agent\'s prompt lists it with its skill, which loads only while it is on for the agent; removing it takes both away', async () => {
    const account = await createAccount('apps-web');
    const juno = await defaultAgent(account);
    const app = async () => ((await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; category: string; auth: string; available: boolean; installations: Array<{ id: string }>; enabledAgents: unknown[] }>).find((item) => item.id === 'youtube-videos');
    expect(await app()).toMatchObject({ category: 'web', auth: 'none', available: true, installations: [], enabledAgents: [] });
    // Not added yet: the skill is not there to read.
    const before = await scriptedChat(account, juno.id, [{ toolCalls: [toolCall('skill', 'skill_read', { name: 'youtube-videos/agent-reach' })] }, { text: 'ok' }], 'hello');
    await waitForTranscript(before.sessionKey, (rows) => rows.some((row) => row.includes('## Where you are')));
    expect((await transcriptTexts(before.sessionKey)).join('\n')).not.toContain('agent-reach youtube subtitle');

    const added = await account.api('POST', '/v1/apps/youtube-videos/install', {});
    expect(added.status).toBe(201);
    const installationId: string = added.body.installation.id;
    expect(await app()).toMatchObject({ installations: [{ id: installationId }], enabledAgents: [{ agentId: juno.id }] });
    const second = await scriptedChat(account, juno.id, [{ toolCalls: [toolCall('skill', 'skill_read', { name: 'youtube-videos/agent-reach' })] }, { text: 'ok' }], 'hello again');
    await waitForTranscript(second.sessionKey, (rows) => rows.some((row) => row.includes('- YouTube videos: ') && row.includes('read its skill first (skill_read): youtube-videos/agent-reach')));
    await waitForTranscript(second.sessionKey, (rows) => rows.some((row) => row.includes('agent-reach youtube subtitle')));

    // Removed through the gateway like any app: the page, the prompt and the skill follow.
    expect((await account.api('DELETE', `/v1/apps/youtube-videos/installations/${installationId}`)).status).toBe(204);
    expect(await app()).toMatchObject({ installations: [], enabledAgents: [] });
    const third = await scriptedChat(account, juno.id, [{ text: 'ok' }], 'once more');
    await waitForTranscript(third.sessionKey, (rows) => rows.some((row) => row.includes('## Where you are')));
    expect((await transcriptTexts(third.sessionKey)).join('\n')).not.toContain('YouTube videos');
  });

  it('an operator adds, edits and retires an app through the admin path with no restart: the page, the prompt and the agent\'s switch follow', async () => {
    interface AdminBody { items?: Array<{ id: string; status: string }>; id?: string; status?: string }
    const admin = async (method: string, path: string, body?: unknown, token = ADMIN_TOKEN): Promise<{ status: number; body: AdminBody }> => {
      const response = await fetch(stackUrls().apiUrl + path, { method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as AdminBody };
    };
    // The path is closed to anyone without the admin token (a user's own session is not it).
    expect((await admin('GET', '/admin/v1/apps', undefined, 'not-the-token')).status).toBe(401);
    const seeded = (await admin('GET', '/admin/v1/apps')).body.items ?? [];
    expect(seeded.map((row) => row.id)).toEqual(expect.arrayContaining(['slack', 'gmail', 'notion']));

    const account = await createAccount('apps-admin');
    const juno = await defaultAgent(account);
    const appNamed = async (id: string) => ((await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; blurb: string; tryAsking: string[]; installations: unknown[] }>).find((app) => app.id === id);
    expect(await appNamed('e2e-notes')).toBeUndefined();

    // Added: listed at once, with the text the operator wrote, and a bad row is refused.
    const face = { displayName: 'E2E Notes', shortDescription: 'Notes for tests.', longDescription: 'Search and add notes.', icon: 'notes', defaultPrompts: ['Find my notes'] };
    const server = { notes: { type: 'streamable-http', url: mail.url, auth: 'none' } };
    const skill = { name: 'overview', description: 'How E2E Notes works. Use when the person asks about their notes.', instructions: 'Notes live in notebooks. Open a notebook before searching it.' };
    expect((await admin('POST', '/admin/v1/apps', { id: 'e2e-notes', category: 'work', interface: face, mcpServers: server, skills: [skill] })).status).toBe(201);
    expect((await admin('POST', '/admin/v1/apps', { id: 'e2e-notes', category: 'work', interface: face, mcpServers: server })).status).toBe(409);
    expect((await admin('POST', '/admin/v1/apps', { id: 'bad-app', category: 'work', interface: face, mcpServers: { bad: { type: 'streamable-http', url: 'http://example.com/mcp', auth: 'none' } } })).status).toBe(400);
    expect(await appNamed('e2e-notes')).toMatchObject({ blurb: 'Notes for tests.', tryAsking: ['Find my notes'], installations: [] });
    expect((await admin('PATCH', '/admin/v1/apps/e2e-notes', { interface: { ...face, shortDescription: 'Notes, edited.' } })).body).toMatchObject({ id: 'e2e-notes', version: 2 });
    expect((await appNamed('e2e-notes'))?.blurb).toBe('Notes, edited.');

    // The owner adds it (here the signed-in row); the agent's prompt lists it and says it has a how-to skill, which skill_read returns.
    await insertDocRow('connections', account.userId, { id: 'con-e2e-notes-' + account.userId.slice(0, 12), kind: 'mcp', name: 'E2E Notes', status: 'connected', enabled: true, catalogId: 'e2e-notes', connectedAt: NOW, endpoint: mail.url, transport: 'http' });
    const first = await scriptedChat(account, juno.id, [{ toolCalls: [toolCall('skill', 'skill_read', { name: 'e2e-notes/overview' })] }, { text: 'ok' }], 'hello');
    await waitForTranscript(first.sessionKey, (rows) => rows.some((row) => row.includes('- E2E Notes: ') && row.includes('has a how-to skill: e2e-notes/overview')));
    await waitForTranscript(first.sessionKey, (rows) => rows.some((row) => row.includes('Open a notebook before searching it.')));

    // Retired: gone from the page, from the agent's prompt and from its switches, with the connection row left as it was.
    expect((await admin('POST', '/admin/v1/apps/e2e-notes/retire')).body).toMatchObject({ id: 'e2e-notes', status: 'retired' });
    expect(await appNamed('e2e-notes')).toBeUndefined();
    expect((await account.api('PUT', `/v1/agents/${juno.id}/apps/e2e-notes`, { enabled: true })).status).toBe(404);
    const second = await scriptedChat(account, juno.id, [{ text: 'ok' }], 'hello again');
    await waitForTranscript(second.sessionKey, (rows) => rows.some((row) => row.includes('## Where you are')));
    expect((await transcriptTexts(second.sessionKey)).join('\n')).not.toContain('E2E Notes');
  });
});
