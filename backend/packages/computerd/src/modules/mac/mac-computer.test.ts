import { describe, expect, it } from 'vitest';
import { unavailable, type LinkConnection, type LinkHub } from '@agent-desktop/sandbox-adapters';
import type { DeviceAction, DeviceDeclaration } from 'juno-link/protocol';
import { createMemoryStore } from '@agent-desktop/db';
import { createControlGateway, type ControlGateway } from '../control/gateway.js';
import { createMacComputers, MAC_OFFLINE, MAC_OFFLINE_AFTER_DISPATCH, MAC_UNDECLARED } from './mac-computer.js';
import type { MacRegistry } from './registry.js';

const registry = (): MacRegistry => ({
  pair: () => ({ id: 'mac-abcdefgh', name: 'Mac', pairedAt: '' }),
  get: () => ({ id: 'mac-abcdefgh', name: 'Mac', pairedAt: '' }),
  revoke: () => undefined,
  ownerOf: () => 'owner',
  withdrawn: () => false,
});

/** A control gateway over its own store, so one test's Stop never reaches another's Mac. */
const gateway = (): ControlGateway => {
  const store = createMemoryStore().forOwner?.('owner');
  if (!store) throw new Error('scoped store required');
  return createControlGateway({ store, ownerId: 'owner' });
};

function hub(connection: LinkConnection | Error): LinkHub {
  return {
    tokenFor: () => 'token',
    accept: () => undefined,
    get: () => connection instanceof Error ? undefined : connection,
    waitFor: async () => { if (connection instanceof Error) throw connection; return connection; },
    drop: () => undefined,
    sendStop: () => false,
    linked: () => [],
    close: () => undefined,
  };
}

const ALL: DeviceAction[] = ['files', 'shell', 'desktop', 'browser', 'audio', 'apps'];
const declaration = (actions: DeviceAction[]): DeviceDeclaration => ({ deviceId: 'dev-1', name: "Robin's MacBook", osVersion: 'macOS 15.2', actions });

/** `declared` is read on every call, like the hub's session: change it to play a Mac that re-declares. */
function link(desktop: (input: Record<string, unknown>) => Promise<unknown>, declared: { current: DeviceDeclaration | undefined } = { current: declaration(ALL) }): LinkConnection {
  return {
    id: 'mac-abcdefgh', bootId: 'boot', open: true,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
    health: async () => ({ ok: true, bootId: 'boot', version: 1, uptimeMs: 1, host: { platform: 'darwin', arch: 'arm64', release: '25', user: 'robin', home: '/Users/robin', roots: ['/Users/robin/Juno'], desktop: true } }),
    device: () => declared.current,
    openStream: async () => { throw new Error('unused'); },
    desktop: async (request) => desktop(request.input),
  };
}

const signal = () => new AbortController().signal;

describe('Mac desktop dispatch', () => {
  it('reports an offline Mac before dispatch as having run nothing', async () => {
    const mac = createMacComputers({ control: () => gateway(), hub: hub(unavailable('offline')), registry: registry(), waitMs: 1 }).forOwner('owner');
    await expect(mac.desktop('agent-a', 'act', { app: 'Notes', steps: [] }, signal())).rejects.toMatchObject({
      code: 'unavailable', message: MAC_OFFLINE,
    });
  });

  it('does not claim nothing ran or repeat a call when the link drops after dispatch', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const mac = createMacComputers({ control: () => gateway(),
      hub: hub(link(async (input) => { calls.push(input); throw unavailable('link dropped'); })),
      registry: registry(), waitMs: 1,
    }).forOwner('owner');
    await expect(mac.desktop('agent-a', 'act', { app: 'Notes', steps: [{ tool: 'type_text' }] }, signal())).rejects.toMatchObject({
      code: 'unavailable', message: MAC_OFFLINE_AFTER_DISPATCH,
    });
    expect(calls).toEqual([{ app: 'Notes', steps: [{ tool: 'type_text' }] }]);
  });
});

describe('Mac declared actions', () => {
  it('refuses an undeclared action with what to ask the owner, without sending it to the Mac', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const declared = { current: declaration(['files', 'shell']) };
    const mac = createMacComputers({ control: () => gateway(), hub: hub(link(async (input) => { calls.push(input); return {}; }, declared)), registry: registry(), waitMs: 1 }).forOwner('owner');
    await expect(mac.desktop('agent-a', 'snapshot', {}, signal())).rejects.toMatchObject({
      code: 'not_allowed', message: expect.stringContaining('desktop driver'),
    });
    await expect(mac.desktop('agent-a', 'act', { app: 'Notes', steps: [] }, signal())).rejects.toMatchObject({ code: 'not_allowed', message: expect.stringContaining('Accessibility') });
    await expect(mac.desktop('agent-a', 'verify', { app: 'Notes', expect: [] }, signal())).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(mac.desktop('agent-a', 'browser', { action: 'tabs' }, signal())).rejects.toMatchObject({ code: 'not_allowed', message: expect.stringContaining('Chrome') });
    await expect(mac.desktop('agent-a', 'audio_start', {}, signal())).rejects.toMatchObject({ code: 'not_allowed', message: expect.stringContaining('audio') });
    await expect(mac.desktop('agent-a', 'mac_apps', { tool: 'mail_list', args: {} }, signal())).rejects.toMatchObject({ code: 'not_allowed', message: expect.stringContaining('Mail') });
    expect(calls).toEqual([]);
  });

  it('follows a Mac that declares again: a granted permission is used, a revoked one is refused, and stopping a recording always works', async () => {
    const calls: string[] = [];
    const declared = { current: declaration(['files', 'shell']) };
    const mac = createMacComputers({ control: () => gateway(), hub: hub(link(async () => { calls.push('sent'); return { ok: true }; }, declared)), registry: registry(), waitMs: 1 }).forOwner('owner');
    await expect(mac.desktop('agent-a', 'snapshot', {}, signal())).rejects.toMatchObject({ code: 'not_allowed' });
    declared.current = declaration(['files', 'shell', 'desktop']);
    await expect(mac.desktop('agent-a', 'snapshot', {}, signal())).resolves.toEqual({ ok: true });
    declared.current = declaration(['files', 'shell']);
    await expect(mac.desktop('agent-a', 'snapshot', {}, signal())).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(mac.desktop('agent-a', 'audio_stop', { recordingId: 'r1' }, signal())).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['sent', 'sent']);
  });

  it('refuses files and shell the Mac did not declare', async () => {
    const declared = { current: declaration(['desktop']) };
    const mac = createMacComputers({ control: () => gateway(), hub: hub(link(async () => ({}), declared)), registry: registry(), waitMs: 1 }).forOwner('owner');
    await expect(mac.readFile('a.txt', signal())).rejects.toMatchObject({ code: 'not_allowed', message: expect.stringContaining('files') });
    await expect(mac.writeFile({ path: 'a.txt', content: 'x' }, signal())).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(mac.shell({ command: 'ls', timeoutMs: 1000 }, signal())).rejects.toMatchObject({ code: 'not_allowed', message: expect.stringContaining('commands') });
    await expect(mac.withTransfer(signal(), async () => 'never')).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(mac.processes.start('agent-a', { command: 'sleep 1' }, signal())).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('refuses a connected Mac that declared nothing', async () => {
    const mac = createMacComputers({ control: () => gateway(), hub: hub(link(async () => ({}), { current: undefined })), registry: registry(), waitMs: 1 }).forOwner('owner');
    await expect(mac.desktop('agent-a', 'snapshot', {}, signal())).rejects.toMatchObject({ code: 'failed', message: MAC_UNDECLARED });
    await expect(mac.shell({ command: 'ls', timeoutMs: 1000 }, signal())).rejects.toMatchObject({ code: 'failed', message: MAC_UNDECLARED });
  });

  it('reports the declaration in the status and in the environment the model is shown', async () => {
    const declared = { current: declaration(['files', 'shell', 'browser']) };
    const mac = createMacComputers({ control: () => gateway(), hub: hub(link(async () => ({}), declared)), registry: registry(), waitMs: 1 }).forOwner('owner');
    expect(await mac.status()).toMatchObject({ paired: true, online: true, device: declared.current });
    expect(await mac.environment(signal())).toMatchObject({ kind: 'mac', device: { name: "Robin's MacBook", osVersion: 'macOS 15.2', actions: ['files', 'shell', 'browser'] } });
    declared.current = declaration(['files', 'shell']);
    expect((await mac.environment(signal())).device?.actions).toEqual(['files', 'shell']);
  });
});
