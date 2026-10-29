/**
 * The plugin host: a thin registry that gives first-party features one way into agentd (docs/BACKEND.md "Plugins").
 * It keeps four ideas from Cordis / DeepSeek Harness (MIT, github.com/cordiverse/cordis) and nothing else:
 *  1. a plugin is a plain object `{ name, inject?, config?, apply(ctx, config) }`;
 *  2. named services with declared dependencies: a plugin is PENDING until every `inject`ed service exists, then ACTIVE,
 *     and `status()` always says which (pending names the missing services, failed carries the error);
 *  3. everything a plugin registers goes through `ctx.effect` (tools, channels, prompt sections, connectors and
 *     provided services are effects) and is undone when the plugin is disabled or the host stops;
 *  4. enable / disable / config come from rows, validated by the plugin's own zod schema; a bad row fails that plugin only.
 *
 * Plugins load once at process start. There is no hot reload: after `load()` the registries are sealed, so the tool set
 * a run sees (the durable runner journals runs) cannot change underneath it. Plugins are in-process first-party code;
 * third-party extensions stay MCP servers in separate processes.
 */
import type { z } from 'zod';
import type { Context } from 'hono';
import type { Tool } from 'juno-agent/contracts';
import type { CatalogEntry } from 'juno-agent/modules/mcp/catalog';
import type { PluginTool, PluginToolBuild } from 'juno-agent/modules/tools/plugin-tool';
import { registerChatSurface } from '@agent-desktop/public-contracts';
import type { ChannelRegistration } from '../channels/registration.js';
import type { AgentdDeps } from '../routes/index.js';

export type Disposer = () => void | Promise<void>;

/** An HTTP route a plugin adds to the internal agentd API (mounted after the core routes, behind the service bearer). */
export interface PluginRouteSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The full path, as the api gateway forwards it (e.g. `/v1/channels/slack/events`). */
  path: string;
  /** Answers the request; `deps` is the same wiring the core routes get. */
  handler(c: Context, deps: AgentdDeps): Response | Promise<Response>;
}

export interface PluginRoute extends PluginRouteSpec {
  /** The plugin that registered it. */
  plugin: string;
}

export interface PluginToolOptions {
  visibleFor?(agentId: string): Promise<boolean>;
  /** Default true: a connected app's tool, hidden outside the owner's own chat. False for a first-party tool the built-in tools' scope rules fit (offered wherever they were). */
  connectedApp?: boolean;
}

/** The one-line logger the host and plugins use (a pino logger fits). */
export interface PluginLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Static system-prompt text. It is computed when the plugin loads and never per run: the prompt is frozen for caching. */
export interface PromptSection {
  name: string;
  order: number;
  text: string;
}

export interface PluginContext<S extends object> {
  readonly name: string;
  readonly log: PluginLog;
  /** A service the plugin declared in `inject` (or provided itself). */
  service<K extends keyof S>(name: K): S[K];
  /** Makes a service available to other plugins; it is withdrawn when this plugin is disabled. */
  provide<K extends keyof S>(name: K, value: S[K]): void;
  /** Runs `register` now; its return value (if any) is called when the plugin is disabled, newest first. */
  effect(register: () => Disposer | void, label?: string): void;
  /**
   * A process-wide side effect (a poller or watcher that must exist once per deployment). In an execution-only
   * worker the host skips these, so extra workers add capacity without opening a second gateway, push or watcher.
   */
  singleton(register: () => Disposer | void, label?: string): void;
  /** A tool, or a build that receives the registry's lookup (for a tool that watches the agent's other tools). */
  readonly tools: { register(tool: Tool | PluginToolBuild, options?: PluginToolOptions): void };
  /** A chat platform, both layers (see channels/registration.ts), under its kind. */
  readonly channels: { register(registration: ChannelRegistration): void };
  readonly prompt: { section(section: PromptSection): void };
  readonly connectors: { register(entry: CatalogEntry): void };
  /** An HTTP route on the internal agentd API; a second plugin cannot register the same method and path. */
  readonly http: { route(spec: PluginRouteSpec): void };
}

export interface Plugin<S extends object, C = undefined> {
  name: string;
  inject?: readonly (keyof S)[];
  /** Validates the plugin's row config; use `.default(...)` when the row may omit it. Absent: the plugin takes no config. */
  config?: z.ZodType<C>;
  /** Method syntax on purpose: it lets a `Plugin<S, Cfg>` be stored as a `Plugin<S, unknown>`. */
  apply(ctx: PluginContext<S>, config: C): void | Promise<void>;
}

/** One line of the config: `enabled` defaults to true. */
export interface PluginRow {
  enabled?: boolean | undefined;
  config?: unknown;
}

export type PluginState = 'pending' | 'active' | 'failed' | 'disabled';
export interface PluginStatus {
  name: string;
  state: PluginState;
  /** Pending: the services still missing. */
  missing?: string[];
  /** Failed: why. */
  error?: string;
}

interface Registered {
  tools: PluginTool[];
  channels: ChannelRegistration[];
  sections: PromptSection[];
  connectors: CatalogEntry[];
  routes: PluginRoute[];
}

interface Entry<S extends object> {
  plugin: Plugin<S, unknown>;
  state: PluginState;
  error?: string;
  effects: { label: string; dispose: Disposer }[];
  registered: Registered;
}

const emptyRegistered = (): Registered => ({ tools: [], channels: [], sections: [], connectors: [], routes: [] });
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface PluginHost<S extends object> {
  /** A core service, available before any plugin loads. */
  provide<K extends keyof S>(name: K, value: S[K]): void;
  use(plugin: Plugin<S, unknown>): void;
  /** Activates every plugin whose services exist, in dependency order, then seals the registries. Never throws for a plugin. */
  load(): Promise<void>;
  status(): PluginStatus[];
  /** Disposes one plugin (and, in turn, any active plugin that injected a service it provided, which goes back to pending). */
  disable(name: string): Promise<void>;
  /** Disposes everything, newest activation first. */
  stop(): Promise<void>;
  tools(): PluginTool[];
  channels(): ChannelRegistration[];
  promptSections(): PromptSection[];
  connectors(): CatalogEntry[];
  /** The HTTP routes of the active plugins; a disabled, pending or failed plugin's routes are absent (they answer 404). */
  routes(): PluginRoute[];
}

export function createPluginHost<S extends object>(options: { log: PluginLog; rows?: Readonly<Record<string, PluginRow>>; /** Run plugin process singletons (default true; false in an execution-only worker). */ singletons?: boolean }): PluginHost<S> {
  const { log } = options;
  const singletons = options.singletons ?? true;
  const rows = options.rows ?? {};
  const entries: Entry<S>[] = [];
  const activation: Entry<S>[] = [];
  const services: { [K in keyof S]?: S[K] } = {};
  let sealed = false;

  const has = (name: keyof S): boolean => Object.hasOwn(services, name);
  const missingOf = (entry: Entry<S>): string[] => (entry.plugin.inject ?? []).filter((name) => !has(name)).map(String);

  function put<K extends keyof S>(name: K, value: S[K]): void {
    if (has(name)) throw new Error(`service "${String(name)}" is already provided`);
    services[name] = value;
  }

  async function dispose(entry: Entry<S>): Promise<void> {
    for (const effect of entry.effects.splice(0).reverse()) {
      try { await effect.dispose(); } catch (error) { log.error({ plugin: entry.plugin.name, effect: effect.label, err: error }, 'plugin effect failed to dispose'); }
    }
    entry.registered = emptyRegistered();
    const at = activation.indexOf(entry);
    if (at >= 0) activation.splice(at, 1);
  }

  function contextOf(entry: Entry<S>): PluginContext<S> {
    const name = entry.plugin.name;
    const injected = new Set<keyof S>(entry.plugin.inject ?? []);
    const effect = (register: () => Disposer | void, label = 'effect'): void => {
      const dispose = register();
      entry.effects.push({ label, dispose: dispose ?? (() => undefined) });
    };
    const singleton = (register: () => Disposer | void, label = 'singleton'): void => {
      if (!singletons) { log.info({ plugin: name, effect: label }, 'plugin singleton skipped in this role'); return; }
      effect(register, label);
    };
    const provide = <K extends keyof S>(service: K, value: S[K]): void => {
      put(service, value);
      injected.add(service);
      entry.effects.push({ label: `service ${String(service)}`, dispose: () => { if (services[service] === value) delete services[service]; } });
    };
    /** Registrations are fixed at start: a run's tool set must not change underneath it. */
    const add = <T>(list: T[], item: T, label: string, undo: () => void): void => {
      if (sealed) throw new Error(`plugin "${name}" registered a ${label} after start; registrations are fixed once plugins have loaded`);
      effect(() => { list.push(item); return undo; }, label);
    };
    const remove = <T>(list: T[], item: T) => (): void => { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1); };
    const reg = (): Registered => entry.registered;
    return {
      name,
      log: { info: (f, m) => log.info({ plugin: name, ...f }, m), warn: (f, m) => log.warn({ plugin: name, ...f }, m), error: (f, m) => log.error({ plugin: name, ...f }, m) },
      service(service) {
        if (!injected.has(service)) throw new Error(`plugin "${name}" used service "${String(service)}" without declaring it in inject`);
        // `inject` guarantees presence before apply runs; the value may legitimately be undefined (an optional service).
        return services[service] as S[typeof service];
      },
      provide,
      effect,
      singleton,
      tools: {
        register(tool, opts) {
          if (entries.some((e) => e.registered.tools.some((t) => t.tool.name === tool.name))) throw new Error(`tool "${tool.name}" is already registered by a plugin`);
          const item: PluginTool = {
            tool,
            ...(opts?.visibleFor === undefined ? {} : { visibleFor: opts.visibleFor }),
            ...(opts?.connectedApp === undefined ? {} : { connectedApp: opts.connectedApp }),
          };
          add(reg().tools, item, `tool ${tool.name}`, remove(reg().tools, item));
        },
      },
      http: {
        route(spec) {
          const key = spec.method.toUpperCase() + ' ' + spec.path;
          if (entries.some((e) => e.registered.routes.some((r) => r.method === spec.method && r.path === spec.path))) throw new Error(`route "${key}" is already registered by a plugin`);
          const item: PluginRoute = { ...spec, plugin: name };
          add(reg().routes, item, `route ${key}`, remove(reg().routes, item));
        },
      },
      channels: {
        register(registration) {
          if (entries.some((e) => e.registered.channels.some((c) => c.kind === registration.kind))) throw new Error(`channel "${registration.kind}" is already registered by a plugin`);
          add(reg().channels, registration, `channel ${registration.kind}`, remove(reg().channels, registration));
          // What the chats of this platform can do is read by the agent's tools and prompt (juno-agent), which cannot import adapters.
          effect(() => registerChatSurface(registration.kind, registration.adapter.capabilities), `chat surface ${registration.kind}`);
        },
      },
      prompt: {
        section(section) {
          if (typeof section.text !== 'string') throw new Error(`prompt section "${section.name}" must be static text computed at load, not a function`);
          if (!Number.isFinite(section.order)) throw new Error(`prompt section "${section.name}" needs a numeric order`);
          if (entries.some((e) => e.registered.sections.some((s) => s.name === section.name))) throw new Error(`prompt section "${section.name}" is already registered by a plugin`);
          add(reg().sections, section, `prompt section ${section.name}`, remove(reg().sections, section));
        },
      },
      connectors: {
        register(entryToAdd) {
          if (entries.some((e) => e.registered.connectors.some((c) => c.id === entryToAdd.id))) throw new Error(`connector "${entryToAdd.id}" is already registered by a plugin`);
          add(reg().connectors, entryToAdd, `connector ${entryToAdd.id}`, remove(reg().connectors, entryToAdd));
        },
      },
    };
  }

  async function activate(entry: Entry<S>): Promise<void> {
    const plugin = entry.plugin;
    const row = rows[plugin.name];
    let config: unknown;
    if (plugin.config !== undefined) {
      const parsed = plugin.config.safeParse(row?.config);
      if (!parsed.success) {
        entry.state = 'failed';
        entry.error = 'invalid config: ' + parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ');
        return;
      }
      config = parsed.data;
    }
    activation.push(entry);
    try {
      await plugin.apply(contextOf(entry), config);
      entry.state = 'active';
    } catch (error) {
      await dispose(entry);
      entry.state = 'failed';
      entry.error = describe(error);
    }
  }

  const flatten = <T>(pick: (registered: Registered) => T[]): T[] => entries.flatMap((entry) => (entry.state === 'active' ? pick(entry.registered) : []));
  const statusOf = (entry: Entry<S>): PluginStatus => ({
    name: entry.plugin.name,
    state: entry.state,
    ...(entry.state === 'pending' ? { missing: missingOf(entry) } : {}),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  });

  return {
    provide(name, value) { put(name, value); },
    use(plugin) {
      if (sealed) throw new Error(`plugin "${plugin.name}" added after start`);
      if (entries.some((e) => e.plugin.name === plugin.name)) throw new Error(`plugin "${plugin.name}" is already added`);
      entries.push({ plugin, state: rows[plugin.name]?.enabled === false ? 'disabled' : 'pending', effects: [], registered: emptyRegistered() });
    },
    async load() {
      for (const name of Object.keys(rows)) if (!entries.some((e) => e.plugin.name === name)) log.warn({ plugin: name }, 'plugin config names an unknown plugin');
      for (let progressed = true; progressed; ) {
        progressed = false;
        for (const entry of entries) {
          if (entry.state !== 'pending' || missingOf(entry).length > 0) continue;
          progressed = true;
          await activate(entry);
        }
      }
      sealed = true;
      for (const status of entries.map(statusOf)) {
        if (status.state === 'active') log.info({ plugin: status.name }, 'plugin active');
        else if (status.state === 'pending') log.warn({ plugin: status.name, missing: status.missing }, 'plugin pending: services missing');
        else if (status.state === 'failed') log.error({ plugin: status.name, error: status.error }, 'plugin failed');
        else log.info({ plugin: status.name }, 'plugin disabled by config');
      }
    },
    status: () => entries.map(statusOf),
    async disable(name) {
      const target = entries.find((e) => e.plugin.name === name);
      if (target === undefined) throw new Error(`unknown plugin "${name}"`);
      await dispose(target);
      target.state = 'disabled';
      // A plugin that injected a service this one provided cannot keep running without it.
      for (let again = true; again; ) {
        again = false;
        for (const entry of [...activation]) {
          if (entry.state !== 'active' || missingOf(entry).length === 0) continue;
          await dispose(entry);
          entry.state = 'pending';
          again = true;
        }
      }
    },
    async stop() {
      for (const entry of [...activation].reverse()) {
        await dispose(entry);
        entry.state = 'disabled';
      }
    },
    tools: () => flatten((r) => r.tools),
    channels: () => flatten((r) => r.channels),
    promptSections: () => flatten((r) => r.sections).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    connectors: () => flatten((r) => r.connectors),
    routes: () => flatten((r) => r.routes),
  };
}
