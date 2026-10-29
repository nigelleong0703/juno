import type { ApiClient } from '../index.js';
import { describe, expect, it } from 'vitest';
import {
  appDetailSchema,
  appSchema,
  channelKindSchema,
  connectChannelInputSchema,
  connectPayloadSchema,
  conversationSchema,
  installAppChatInputSchema,
  installAppCustomInputSchema,
  installAppResponseSchema,
  itemSchema,
  setAgentAppInputSchema,
} from '../index.js';

const installation = { id: 'slack:T1', appId: 'slack', label: 'Acme', status: 'connected', bound: true, agents: [{ agentId: 'a1', handle: 'nova', handleStatus: 'ok' }] };
const app = { id: 'slack', name: 'Slack', category: 'chat', source: 'official', icon: 'slack', blurb: 'b', description: 'd', tryAsking: ['Ask me'], auth: 'bot_install', available: true, userConfig: [], version: 1, grants: { chatRead: true, actions: false }, installations: [installation], enabledAgents: [{ agentId: 'a1' }] };

describe('channel contracts', () => {
  it('keeps the old kinds and adds the platforms', () => {
    for (const kind of ['chat', 'slack', 'email', 'sms', 'phone', 'telegram', 'discord', 'feishu']) {
      expect(channelKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(channelKindSchema.safeParse('fax').success).toBe(false);
  });

  it('accepts the install bodies that need no pasted credential and refuses a pasted token or secret', () => {
    for (const body of [{ mode: 'managed' }, { mode: 'register', domain: 'lark' }, { mode: 'oauth' }]) {
      expect(connectChannelInputSchema.safeParse(body).success).toBe(true);
      expect(installAppChatInputSchema.safeParse({ ...body, agentId: 'a1' }).success).toBe(true);
    }
    for (const body of [{ botToken: 't' }, { appId: 'a', appSecret: 's' }, { mode: 'manual', botToken: 'b' }]) {
      expect(connectChannelInputSchema.safeParse(body).success).toBe(false);
    }
  });

  it('carries an optional channel origin on a conversation', () => {
    const base = { id: 'c1', kind: 'direct', agentIds: ['a1'], memberIds: ['u1'], unreadCount: 0, lastItemAt: '2026-10-19T00:00:00.000Z', createdAt: '2026-10-19T00:00:00.000Z' };
    expect(conversationSchema.parse(base).channel).toBeUndefined();
    expect(conversationSchema.parse({ ...base, channel: { kind: 'telegram', channelId: 'JunoBot' } }).channel).toEqual({ kind: 'telegram', channelId: 'JunoBot' });
  });

  it('carries item origins', () => {
    const origin = { kind: 'slack', channelId: 'T1.S1', chatId: 'D1', chatType: 'private' };
    const at = '2026-10-19T00:00:00.000Z';
    expect(itemSchema.parse({ id: 'i1', conversationId: 'c1', at, type: 'agent_message', agentId: 'a1', markdown: 'hi', citations: [], replyTo: origin })).toMatchObject({ replyTo: origin });
    expect(itemSchema.parse({ id: 'i2', conversationId: 'c1', at, type: 'user_message', authorId: 'u1', text: 'hi', attachments: [], mentions: [], source: origin })).toMatchObject({ source: origin });
  });
});

describe('apps contracts', () => {
  it('parses an app, its detail and an install answer, and has no bind code or credential anywhere', () => {
    expect(appSchema.parse(app).installations[0]?.agents[0]?.handle).toBe('nova');
    const detail = appDetailSchema.parse({ ...app, capabilities: [{ name: 'reply', title: 'Reply', kind: 'read' }], pending: [{ id: 'p1', status: 'pending', expiresAt: '2026-10-19T00:10:00.000Z', openUrl: 'https://x' }], skills: [{ name: 'welcome', description: 'First steps.', onboarding: true }] });
    expect(detail.pending[0]?.status).toBe('pending');
    const answer = installAppResponseSchema.parse({ appId: 'telegram', installation: null, pending: null, openUrl: 'https://t.me/JunoBot?start=x', bindCode: 'c' });
    expect('bindCode' in answer).toBe(false);
    expect(appSchema.safeParse({ ...app, category: 'game' }).success).toBe(false);
    expect(appSchema.safeParse({ ...app, auth: 'magic' }).success).toBe(false);
  });

  it('knows the three Actions policies and the custom install bodies', () => {
    for (const actionsPolicy of ['ask', 'allow', 'off']) expect(setAgentAppInputSchema.safeParse({ enabled: true, actionsPolicy }).success).toBe(true);
    expect(setAgentAppInputSchema.safeParse({ enabled: true, actionsPolicy: 'sometimes' }).success).toBe(false);
    expect(installAppCustomInputSchema.safeParse({ name: 'Mine', url: 'https://mcp.example.com' }).success).toBe(true);
    expect(installAppCustomInputSchema.safeParse({ connectionId: 'con-1' }).success).toBe(true);
  });

  it('a Connect card names the apps and why each is not usable', () => {
    expect(connectPayloadSchema.parse({ kind: 'connect', appIds: ['gmail', 'mac'], problems: { gmail: 'not_enabled' }, label: 'Mail' }).problems).toEqual({ gmail: 'not_enabled' });
    expect(connectPayloadSchema.safeParse({ kind: 'connect', appIds: ['gmail'], problems: { gmail: 'broken' }, label: 'Mail' }).success).toBe(false);
  });

  it('types AppsApi on ApiClient', () => {
    // Compile-time check only.
    const use = (api: ApiClient) => [api.apps.list(), api.apps.install('hevy', { userConfig: { api_key: 'k' } }), api.apps.install('slack', { mode: 'oauth' }), api.apps.setAgentApp('a1', 'gmail', { enabled: true, actionsPolicy: 'ask' })];
    expect(typeof use).toBe('function');
  });
});
