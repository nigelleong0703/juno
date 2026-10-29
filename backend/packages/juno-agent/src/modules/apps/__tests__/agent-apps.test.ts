import { describe, expect, it } from 'vitest';
import type { Connection } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import { accessSentence, agentAppSettings, appAccess, appIdOfConnection, appProblem, connectionStanding, problemsOf, settingFor, setAgentApp, usableApps } from '../agent-apps.js';

const OWNER = 'owner-1';
const NOW = '2026-10-26T00:00:00.000Z';
const connection = (id: string, extra: Partial<Connection> = {}): Connection => ({ id, name: id, kind: 'mcp', status: 'connected', ...extra });

describe('how a connection stands', () => {
  it('connected, expired (it worked and is now rejected), error (never worked), or not added', () => {
    expect(connectionStanding(connection('a'))).toBe('connected');
    expect(connectionStanding(connection('a', { status: 'error', connectedAt: NOW }))).toBe('expired');
    expect(connectionStanding(connection('a', { status: 'error' }))).toBe('error');
    expect(connectionStanding(connection('a', { status: 'disconnected' }))).toBeUndefined();
    expect(connectionStanding(connection('a', { enabled: false }))).toBeUndefined();
  });

  it('an app is the catalog entry, or the custom server itself', () => {
    expect(appIdOfConnection(connection('con-1', { catalogId: 'gmail' }))).toBe('gmail');
    expect(appIdOfConnection(connection('con-1'))).toBe('con-1');
  });
});

describe('what an agent can use', () => {
  const connections = [connection('c1', { catalogId: 'gmail', name: 'Gmail' }), connection('c2', { catalogId: 'notion', name: 'Notion' }), connection('c3', { catalogId: 'linear', name: 'Linear', status: 'error', connectedAt: NOW }), connection('c4')];

  it('no row means on, with actions asking first: a new agent works with every added app', async () => {
    const store = createMemoryStore();
    const settings = await agentAppSettings(store, 'agent-1');
    expect(settingFor(settings, 'gmail')).toEqual({ enabled: true, actionsPolicy: 'ask' });
    expect([...usableApps(connections, settings).keys()]).toEqual(['gmail', 'notion', 'c4']);
  });

  it('one row changes one agent and one app; a field left out keeps what it was', async () => {
    const store = createMemoryStore();
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-1', appId: 'notion', enabled: false });
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-1', appId: 'gmail', actionsPolicy: 'allow' });
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-1', appId: 'notion', actionsPolicy: 'off' });
    const settings = await agentAppSettings(store, 'agent-1');
    expect(settingFor(settings, 'notion')).toEqual({ enabled: false, actionsPolicy: 'off' });
    expect(settingFor(settings, 'gmail')).toEqual({ enabled: true, actionsPolicy: 'allow' });
    expect([...usableApps(connections, settings).keys()]).toEqual(['gmail', 'c4']);
    expect(settingFor(await agentAppSettings(store, 'agent-2'), 'notion').enabled).toBe(true);
  });

  it('says why an app is not usable: not added, off for the agent, or its sign-in expired', async () => {
    const store = createMemoryStore();
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-1', appId: 'notion', enabled: false });
    const settings = await agentAppSettings(store, 'agent-1');
    expect(appProblem(connections, settings, 'gmail')).toBeUndefined();
    expect(appProblem(connections, settings, 'notion')).toBe('not_enabled');
    expect(appProblem(connections, settings, 'linear')).toBe('expired');
    expect(appProblem(connections, settings, 'stripe')).toBe('not_added');
    expect(problemsOf(['gmail', 'notion', 'stripe', 'mac'], (id) => appProblem(connections, settings, id))).toEqual({ notion: 'not_enabled', stripe: 'not_added' });
    expect(problemsOf(['gmail'], (id) => appProblem(connections, settings, id))).toBeUndefined();
  });

  it('one access state per app and agent: ready, or the first thing in the way, each with the one sentence the model gets', async () => {
    const store = createMemoryStore();
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-1', appId: 'notion', enabled: false });
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-1', appId: 'gmail', actionsPolicy: 'off' });
    const settings = await agentAppSettings(store, 'agent-1');
    const rows = [
      ...connections,
      connection('c5', { catalogId: 'asana', name: 'Asana', status: 'error' }),
      connection('c6', { catalogId: 'google-calendar', name: 'Google Calendar', status: 'error', connectedAt: NOW, ...{ needsScope: 'https://www.googleapis.com/auth/calendar' } }),
    ];
    const state = (appId: string, tool?: 'read' | 'action') => appAccess(rows, settings, appId, tool);
    expect(state('gmail')).toEqual({ appId: 'gmail', state: 'ready' });
    expect(state('gmail', 'read').state).toBe('ready');
    // Actions off is a per-tool state: a read still works, a change is not granted.
    expect(state('gmail', 'action').state).toBe('not_granted');
    expect(state('stripe').state).toBe('not_added');
    expect(state('notion').state).toBe('not_enabled');
    expect(state('asana').state).toBe('needs_reconnect');
    expect(state('linear').state).toBe('expired');
    // The provider said which permission is missing, and the sentence says so: reconnect, no retry.
    expect(state('google-calendar')).toEqual({ appId: 'google-calendar', state: 'scope_missing', scope: 'https://www.googleapis.com/auth/calendar' });
    expect(accessSentence(state('google-calendar'), 'Google Calendar')).toMatch(/lacks a permission \(https:\/\/www\.googleapis\.com\/auth\/calendar\).*reconnect Google Calendar.*connect_request.*Do not retry/);
    expect(accessSentence(state('linear'), 'Linear')).toMatch(/Linear's sign-in expired.*reconnect Linear.*Do not retry/);
    expect(accessSentence(state('gmail', 'action'), 'Gmail', 'gmail_send')).toMatch(/gmail_send changes things in Gmail, and Actions is off/);
    expect(accessSentence(state('gmail'), 'Gmail')).toBeUndefined();
    // The Connect card gets the same states, and never a per-tool one.
    expect(problemsOf(['gmail', 'asana', 'google-calendar'], (id) => appProblem(rows, settings, id))).toEqual({ asana: 'needs_reconnect', 'google-calendar': 'scope_missing' });
  });
});
