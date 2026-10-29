/**
 * The monitors plugin: the agent's own watches (BACKEND 3.6.3). It registers `monitor_create` and `monitor_manage`, which the agent
 * uses in a live message from the person it works for. A monitor is a routine with a `check` trigger; the routine timer runs its
 * checks only while this plugin is active (boot passes `monitorChecks` to the execution service, see juno-agent runtime.ts).
 *
 * Disabled (`JUNO_PLUGINS={"monitors":{"enabled":false}}`): the two tools are absent and the existing monitors are paused. Their
 * routines are kept, so enabling the plugin again resumes them. The tools are first-party: offered wherever the built-in tools are,
 * so they are not marked as connected apps.
 */
import { createMonitorCreateTool, createMonitorManageTool } from 'juno-agent/modules/tools/tools/monitorTools';
import { requestScopedStore } from '../owner-scope.js';
import type { AgentdPlugin } from '../plugins/services.js';

export const monitorsPlugin: AgentdPlugin = {
  name: 'monitors',
  inject: ['store', 'enqueuer'],
  apply(ctx) {
    // The same request-scoped view the execution tools get (runtime.ts): the tools write the monitor's state and routine under the
    // owner whose run calls them. The raw store would file a row with no owner under 'unknown', and the owner could never update it.
    const store = requestScopedStore(ctx.service('store'));
    const enqueuer = ctx.service('enqueuer');
    // monitor_create finds the tool it watches with among everything the agent can use, so it is built with the registry's lookup.
    ctx.tools.register({ name: 'monitor_create', build: (tools) => createMonitorCreateTool({ store, enqueuer, tools }) }, { connectedApp: false });
    ctx.tools.register(createMonitorManageTool({ store, enqueuer }), { connectedApp: false });
  },
};
