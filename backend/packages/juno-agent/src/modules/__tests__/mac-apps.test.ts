import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../testing/store.js';
import { allowMacApp, listMacApps, macAppAllowed, macAppKey, noteMacAppUsed, revokeMacApp } from '../mac-apps.js';

describe('apps allowed on the Mac', () => {
  it('keeps an app for good, once, and lists it for the owner to see and take back', async () => {
    const store = createMemoryStore();
    expect(await listMacApps(store)).toEqual([]);
    await allowMacApp(store, 'owner', ' Notes ', 'Notes');
    await allowMacApp(store, 'owner', 'notes', 'Notes');
    await allowMacApp(store, 'owner', 'com.apple.Mail', 'Mail');
    const apps = await listMacApps(store);
    expect(apps.map((app) => [app.app, app.name]).sort()).toEqual([['com.apple.mail', 'Mail'], ['notes', 'Notes']]);

    await noteMacAppUsed(store, 'NOTES');
    expect((await listMacApps(store)).find((app) => app.app === 'notes')?.lastUsedAt).toBeDefined();

    const rules = (await store.list('rules', { limit: 50 })).items;
    expect(macAppAllowed(rules, 'Notes')).toBe(true);
    expect(macAppAllowed(rules, 'Notion')).toBe(false);
    expect(macAppAllowed(rules, 'COM.APPLE.MAIL')).toBe(true);

    expect(await revokeMacApp(store, 'Notes')).toBe(true);
    expect(await revokeMacApp(store, 'Notes')).toBe(false);
    expect((await listMacApps(store)).map((app) => app.app)).toEqual(['com.apple.mail']);
  });

  it('does not touch other rules and normalizes the key', async () => {
    const store = createMemoryStore();
    await store.put('rules', { id: 'r1', description: 'Gmail', scope: 'app', behavior: 'auto', source: 'user', enabled: true, subject: 'Gmail', createdAt: '2026-10-23T00:00:00.000Z' });
    expect(await listMacApps(store)).toEqual([]);
    expect(await revokeMacApp(store, 'Gmail')).toBe(false);
    expect(macAppKey('  Final   Cut  Pro ')).toBe('final cut pro');
  });
});
