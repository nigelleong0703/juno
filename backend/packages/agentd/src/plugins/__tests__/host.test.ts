import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Tool } from 'juno-agent/contracts';
import { telegramAdapter } from '@agent-desktop/channels/sdk';
import { telegramConnector } from '../../channels/telegram/connect.js';
import { pluginRowsFromEnv } from '../config.js';
import { createPluginHost, type Plugin, type PluginLog } from '../host.js';

interface S { base: number; extra: string }

const silent: PluginLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const host = (rows?: Parameters<typeof createPluginHost>[0]['rows']) => createPluginHost<S>({ log: silent, ...(rows ? { rows } : {}) });

const tool = (name: string): Tool => ({
  name, description: name, parameters: { type: 'object' }, replay: 'safe', sideEffect: false,
  async execute() { return { content: [{ type: 'text', text: name }] }; },
});

describe('plugin host', () => {
  it('activates a plugin only once the service it injects exists, whatever order they were added in', async () => {
    const order: string[] = [];
    const h = host();
    h.provide('base', 1);
    h.use({ name: 'consumer', inject: ['extra'], apply(ctx) { order.push('consumer ' + ctx.service('extra')); } });
    h.use({ name: 'provider', inject: ['base'], apply(ctx) { order.push('provider'); ctx.provide('extra', 'x' + ctx.service('base')); } });
    expect(h.status()).toEqual([{ name: 'consumer', state: 'pending', missing: ['extra'] }, { name: 'provider', state: 'pending', missing: [] }]);
    await h.load();
    expect(order).toEqual(['provider', 'consumer x1']);
    expect(h.status().map((s) => s.state)).toEqual(['active', 'active']);
  });

  it('shows a plugin whose service never appears as pending and names it', async () => {
    const h = host();
    let applied = false;
    h.use({ name: 'waiting', inject: ['base', 'extra'], apply() { applied = true; } });
    h.provide('base', 1);
    await h.load();
    expect(applied).toBe(false);
    expect(h.status()).toEqual([{ name: 'waiting', state: 'pending', missing: ['extra'] }]);
  });

  it('removes everything a plugin registered, and what depends on its service, when it is disabled', async () => {
    const h = host();
    const log: string[] = [];
    h.use({
      name: 'full',
      apply(ctx) {
        ctx.provide('extra', 'e');
        ctx.tools.register(tool('t1'), { visibleFor: async () => true });
        ctx.channels.register({ kind: 'telegram', adapter: telegramAdapter, connector: telegramConnector, workingIndicator: false });
        ctx.prompt.section({ name: 'p', order: 1, text: 'static' });
        ctx.effect(() => () => { log.push('timer stopped'); }, 'timer');
      },
    });
    h.use({ name: 'dependent', inject: ['extra'], apply(ctx) { ctx.effect(() => () => { log.push('dependent stopped'); }); } });
    await h.load();
    expect(h.tools().map((t) => t.tool.name)).toEqual(['t1']);
    expect(h.tools()[0]?.visibleFor).toBeDefined();
    expect(h.channels().map((c) => c.kind)).toEqual(['telegram']);
    expect(h.channels()[0]?.adapter).toBe(telegramAdapter);
    expect(h.promptSections()).toEqual([{ name: 'p', order: 1, text: 'static' }]);

    await h.disable('full');
    expect(log).toEqual(['timer stopped', 'dependent stopped']);
    expect(h.tools()).toEqual([]);
    expect(h.channels()).toEqual([]);
    expect(h.promptSections()).toEqual([]);
    expect(h.status()).toEqual([{ name: 'full', state: 'disabled' }, { name: 'dependent', state: 'pending', missing: ['extra'] }]);
  });

  it('hands out prompt sections ordered by `order` (then name), without the sections of a disabled plugin', async () => {
    const h = host({ off: { enabled: false } });
    h.use({ name: 'late', apply(ctx) { ctx.prompt.section({ name: 'late', order: 20, text: 'late text' }); } });
    h.use({ name: 'early', apply(ctx) { ctx.prompt.section({ name: 'b-early', order: 5, text: 'b' }); ctx.prompt.section({ name: 'a-early', order: 5, text: 'a' }); } });
    h.use({ name: 'off', apply(ctx) { ctx.prompt.section({ name: 'off', order: 1, text: 'never' }); } });
    await h.load();
    expect(h.promptSections().map((s) => s.text)).toEqual(['a', 'b', 'late text']);
    // The prompt is frozen at load: nothing can register one afterwards.
    expect(() => h.use({ name: 'after', apply() { return; } })).toThrow(/after start/);
  });

  it('fails only the plugin whose config is invalid, with the reason, and skips plugins the config disables', async () => {
    const schema = z.object({ limit: z.number().int().positive() });
    const applied: string[] = [];
    const strict: Plugin<S, z.infer<typeof schema>> = { name: 'strict', config: schema, apply(_ctx, config) { applied.push('strict ' + config.limit); } };
    const h = host({ strict: { config: { limit: 'many' } }, good: { config: { limit: 3 } }, off: { enabled: false } });
    h.use(strict);
    h.use({ ...strict, name: 'good' });
    h.use({ name: 'off', apply() { applied.push('off'); } });
    h.use({ name: 'bystander', apply() { applied.push('bystander'); } });
    await h.load();
    expect(applied).toEqual(['strict 3', 'bystander']);
    const [first, second, third, fourth] = h.status();
    expect(first).toEqual({ name: 'strict', state: 'failed', error: expect.stringContaining('limit') });
    expect(second).toEqual({ name: 'good', state: 'active' });
    expect(third).toEqual({ name: 'off', state: 'disabled' });
    expect(fourth).toEqual({ name: 'bystander', state: 'active' });
  });

  it('fails a plugin whose apply throws and undoes what it had already registered', async () => {
    const h = host();
    const log: string[] = [];
    h.use({ name: 'broken', apply(ctx) { ctx.tools.register(tool('half')); ctx.effect(() => () => { log.push('undone'); }); throw new Error('boom'); } });
    await h.load();
    expect(h.status()).toEqual([{ name: 'broken', state: 'failed', error: 'boom' }]);
    expect(h.tools()).toEqual([]);
    expect(log).toEqual(['undone']);
  });

  it('seals the registries after load so a run never sees its tools change', async () => {
    const h = host();
    let late: (() => void) | undefined;
    h.use({ name: 'lazy', apply(ctx) { late = () => ctx.tools.register(tool('late')); } });
    await h.load();
    expect(() => late?.()).toThrow(/after start/);
    expect(() => h.use({ name: 'tooLate', apply() { /* never runs */ } })).toThrow(/after start/);
  });

  it('refuses a service the plugin did not declare, a duplicate tool, and a non-static prompt section', async () => {
    const h = host();
    h.provide('base', 1);
    h.use({ name: 'sneaky', apply(ctx) { ctx.service('base'); } });
    h.use({ name: 'one', apply(ctx) { ctx.tools.register(tool('same')); } });
    h.use({ name: 'two', apply(ctx) { ctx.tools.register(tool('same')); } });
    h.use({ name: 'dynamic', apply(ctx) { ctx.prompt.section({ name: 'd', order: 1, text: (() => 'now') as unknown as string }); } });
    await h.load();
    const byName = Object.fromEntries(h.status().map((s) => [s.name, s]));
    expect(byName['sneaky']?.error).toMatch(/without declaring it in inject/);
    expect(byName['one']?.state).toBe('active');
    expect(byName['two']?.error).toMatch(/already registered/);
    expect(byName['dynamic']?.error).toMatch(/static text/);
  });

  it('mounts an HTTP route a plugin registers, and takes it away with the plugin (undo like any other effect)', async () => {
    const h = host();
    const handler = () => new Response('pong');
    h.use({ name: 'web', apply(ctx) { ctx.http.route({ method: 'get', path: '/v1/web/ping', handler }); } });
    h.use({ name: 'off', apply(ctx) { ctx.http.route({ method: 'post', path: '/v1/off/ping', handler }); } });
    await h.load();
    expect(h.routes()).toEqual([{ method: 'get', path: '/v1/web/ping', handler, plugin: 'web' }, { method: 'post', path: '/v1/off/ping', handler, plugin: 'off' }]);
    await h.disable('web');
    expect(h.routes().map((route) => route.plugin)).toEqual(['off']);
  });

  it('a plugin that fails after registering a route leaves no route behind; a disabled one never adds it', async () => {
    const h = host({ quiet: { enabled: false } });
    h.use({ name: 'broken', apply(ctx) { ctx.http.route({ method: 'put', path: '/v1/broken', handler: () => new Response() }); throw new Error('boom'); } });
    h.use({ name: 'quiet', apply(ctx) { ctx.http.route({ method: 'get', path: '/v1/quiet', handler: () => new Response() }); } });
    await h.load();
    expect(h.status().map((s) => s.state)).toEqual(['failed', 'disabled']);
    expect(h.routes()).toEqual([]);
  });

  it('refuses a second plugin on the same method and path, and a route registered after start', async () => {
    const h = host();
    h.use({ name: 'first', apply(ctx) { ctx.http.route({ method: 'get', path: '/v1/same', handler: () => new Response() }); } });
    h.use({ name: 'second', apply(ctx) { ctx.http.route({ method: 'get', path: '/v1/same', handler: () => new Response() }); } });
    h.use({ name: 'other-method', apply(ctx) { ctx.http.route({ method: 'post', path: '/v1/same', handler: () => new Response() }); } });
    let late: (() => void) | undefined;
    h.use({ name: 'lazy', apply(ctx) { late = () => ctx.http.route({ method: 'get', path: '/v1/late', handler: () => new Response() }); } });
    await h.load();
    const byName = Object.fromEntries(h.status().map((s) => [s.name, s]));
    expect(byName['second']?.error).toMatch(/already registered/);
    expect(byName['other-method']?.state).toBe('active');
    expect(() => late?.()).toThrow(/after start/);
  });

  it('builds a tool that needs the registry from a `{ name, build }`, and marks a first-party tool as not a connected app', async () => {
    const h = host();
    const lookup = { forAgent: async () => [tool('watched')] };
    let received: unknown;
    h.use({ name: 'watcher', apply(ctx) { ctx.tools.register({ name: 'watch', build: (tools) => { received = tools; return tool('watch'); } }, { connectedApp: false }); } });
    await h.load();
    const [entry] = h.tools();
    expect(entry?.connectedApp).toBe(false);
    // The host hands the build over untouched; the juno-agent registry calls it with its lookup.
    if (!('build' in (entry?.tool ?? {}))) throw new Error('the tool was not registered as a build');
    const built = (entry?.tool as { build(tools: typeof lookup): Tool }).build(lookup);
    expect(built.name).toBe('watch');
    expect(received).toBe(lookup);
  });

  it('reads plugin rows from JUNO_PLUGINS and rejects a broken value', () => {
    expect(pluginRowsFromEnv({})).toEqual({});
    expect(pluginRowsFromEnv({ JUNO_PLUGINS: '{"meetings":{"enabled":false}}' })).toEqual({ meetings: { enabled: false } });
    expect(() => pluginRowsFromEnv({ JUNO_PLUGINS: '{nope' })).toThrow(/not valid JSON/);
    expect(() => pluginRowsFromEnv({ JUNO_PLUGINS: '{"meetings":{"enable":false}}' })).toThrow(/JUNO_PLUGINS must be/);
  });
});
