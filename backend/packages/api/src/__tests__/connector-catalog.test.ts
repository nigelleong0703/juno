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

  it('a connector id maps to its brand file; a name that is no id has none', () => {
    expect(brandIconUrl('gmail')).toBe('/v1/brand-icons/gmail.png');
    expect(brandIconUrl('microsoft-todo')).toBe('/v1/brand-icons/todo.png');
    expect(brandIconUrl('constructor')).toBeUndefined();
  });

  it('apps an ordinary person cannot connect with one tap are not in the catalog', () => {
    const ids = CONNECTOR_CATALOG.map((entry) => entry.id);
    for (const gone of ['hevy', 'strava', 'salesforce', 'spotify', 'shopify-admin', 'dropbox']) expect(ids, gone).not.toContain(gone);
  });

  it('Calendly and Todoist register dynamically; Asana needs our own app (no dynamic registration) and is listed only with its client', () => {
    const entry = (id: string) => CONNECTOR_CATALOG.find((candidate) => candidate.id === id);
    expect(entry('calendly')).toMatchObject({ url: 'https://mcp.calendly.com', provides: ['calendar.read', 'calendar.write'] });
    expect(entry('calendly')?.configuredClientIssuer).toBeUndefined();
    expect(entry('todoist')).toMatchObject({ url: 'https://ai.todoist.net/mcp', provides: ['tasks.read', 'tasks.write', 'projects.read', 'projects.write'] });
    // A vendor-published read tool is a read; a tool nobody named (a new one, or a write) is not in the table and so asks.
    expect(entry('todoist')?.toolAccess).toMatchObject({ 'find-tasks': 'read', fetch: 'read' });
    expect(entry('todoist')?.toolAccess?.['add-tasks']).toBeUndefined();
    expect(entry('asana')).toMatchObject({ url: 'https://mcp.asana.com/v2/mcp', configuredClientIssuer: 'https://app.asana.com' });
    expect(configuredClientFor('https://app.asana.com', {})).toBeUndefined();
    expect(configuredClientFor('https://app.asana.com', { ASANA_CLIENT_ID: 'id', ASANA_CLIENT_SECRET: 's' })).toMatchObject({ clientId: 'id', clientSecret: 's' });
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
