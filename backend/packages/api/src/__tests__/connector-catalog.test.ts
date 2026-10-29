import { describe, expect, it } from 'vitest';
import { configuredClientFor } from '@agent-desktop/contracts/mcp';
import { brandIconUrl } from '../brand-icons.js';
import { createAgentdCatalog, validateCatalog, type CatalogEntry } from '../modules/connector-catalog.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';

const base: CatalogEntry = { id: 'x', name: 'X', icon: 'x', description: 'd', category: 'productivity', url: 'https://mcp.example.com/mcp' };

describe('connector catalog', () => {
  it('the built-in catalog is valid; Gmail and Calendar are served through this gateway', () => {
    expect(() => validateCatalog(CONNECTOR_CATALOG)).not.toThrow();
    const urls = new Map(CONNECTOR_CATALOG.map((entry) => [entry.id, entry.url]));
    expect(urls.get('gmail')).toBe('/mcp/google/gmail');
    expect(urls.get('google-calendar')).toBe('/mcp/google/calendar');
  });

  it('a connector with a brand file has an icon url, one without has none', () => {
    expect(brandIconUrl('gmail')).toBe('/v1/brand-icons/gmail.png');
    expect(brandIconUrl('microsoft-todo')).toBe('/v1/brand-icons/todo.png');
    expect(CONNECTOR_CATALOG.some((entry) => entry.id === 'sg-transport')).toBe(true);
    expect(brandIconUrl('sg-transport')).toBeUndefined();
    expect(brandIconUrl('constructor')).toBeUndefined();
  });

  it('Strava is Strava\'s own MCP with a configured client, read scopes and a revocation endpoint', () => {
    const strava = CONNECTOR_CATALOG.find((entry) => entry.id === 'strava');
    expect(strava).toMatchObject({ url: 'https://mcp.strava.com/mcp', category: 'health', configuredClientIssuer: 'https://www.strava.com/mcp-issuer', revocationEndpoint: 'https://www.strava.com/oauth/mcp/revoke' });
    expect(strava?.scopes).toEqual(['activity:read_all', 'profile:read_all']);
    expect(strava?.description).toMatch(/Read-only/);
    expect(configuredClientFor('https://www.strava.com/mcp-issuer', { STRAVA_CLIENT_ID: 'id', STRAVA_CLIENT_SECRET: 's' })).toMatchObject({ clientId: 'id', clientSecret: 's' });
    expect(configuredClientFor('https://www.strava.com/mcp-issuer', {})).toBeUndefined();
  });

  it('Calendly and Todoist register dynamically; Dropbox needs our own app (it accepts dynamic registration from a trusted list only)', () => {
    const entry = (id: string) => CONNECTOR_CATALOG.find((candidate) => candidate.id === id);
    expect(entry('calendly')).toMatchObject({ url: 'https://mcp.calendly.com', provides: ['calendar.read', 'calendar.write'] });
    expect(entry('calendly')?.configuredClientIssuer).toBeUndefined();
    expect(entry('todoist')).toMatchObject({ url: 'https://ai.todoist.net/mcp', provides: ['tasks.read', 'tasks.write', 'projects.read', 'projects.write'] });
    // A vendor-published read tool is a read; a tool nobody named (a new one, or a write) is not in the table and so asks.
    expect(entry('todoist')?.toolAccess).toMatchObject({ 'find-tasks': 'read', fetch: 'read' });
    expect(entry('todoist')?.toolAccess?.['add-tasks']).toBeUndefined();
    const dropbox = entry('dropbox');
    expect(dropbox).toMatchObject({ url: 'https://mcp.dropbox.com/mcp', configuredClientIssuer: 'https://www.dropbox.com', provides: ['files.read', 'files.write'] });
    expect(dropbox?.scopes).not.toContain('sharing.write');
    expect(Object.values(dropbox?.toolAccess ?? {}).every((access) => access === 'read')).toBe(true);
    expect(dropbox?.toolAccess?.Delete).toBeUndefined();
    expect(configuredClientFor('https://www.dropbox.com', {})).toBeUndefined();
    expect(configuredClientFor('https://www.dropbox.com', { DROPBOX_CLIENT_ID: 'id', DROPBOX_CLIENT_SECRET: 's' })).toMatchObject({ clientId: 'id', clientSecret: 's', extraAuthParams: { token_access_type: 'offline' } });
  });

  it('Stripe\'s write tools are changes and it provides payments.write', () => {
    const stripe = CONNECTOR_CATALOG.find((entry) => entry.id === 'stripe');
    expect(stripe?.provides).toEqual(['payments.read', 'payments.write']);
    expect(stripe?.toolAccess).toMatchObject({ stripe_api_write: 'change', send_money: 'change', transfer_money: 'change' });
  });

  it('rejects duplicates, non-https urls and a configured-client entry without scopes', () => {
    expect(() => validateCatalog([base, base])).toThrow(/duplicate/);
    expect(() => validateCatalog([{ ...base, url: 'http://mcp.example.com' }])).toThrow(/https/);
    expect(() => validateCatalog([{ ...base, configuredClientIssuer: 'https://accounts.google.com' }])).toThrow(/scopes/);
    expect(() => validateCatalog([{ ...base, id: 'Bad Id' }])).toThrow(/slug/);
  });
});
