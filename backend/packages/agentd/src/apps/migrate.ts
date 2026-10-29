/**
 * One-time move to the Apps model (BACKEND 10.18). Installations are the rows that already exist, so what moves is small:
 *  - a connection's old permission level becomes the Actions policy of each agent the owner had: `read_only` (the default for every
 *    catalog connector until now) is Off, so the action tools stay hidden exactly as before; `full` and a custom server with no level
 *    asked first, which is the default and needs no row. The field is dropped from the connection.
 *  - a Slack workspace answered DMs and plain @-mentions of the app with the owner's main agent, creating that agent's row on the first
 *    one; the row is made now, so the main agent stays enabled in the workspace and the answer does not change.
 * No reconnect is needed anywhere: every connection, workspace and bot keeps its credentials. A marker row makes later boots skip it.
 */
import type { Store } from 'juno-agent/contracts';
import { appIdOfConnection, setAgentApp } from 'juno-agent/modules/apps/agent-apps';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { jobAgent, ownerAgents } from 'juno-agent/modules/memory/jobs/agent';
import { docOwner } from 'juno-agent/execution/execution-owner';
import { listAll } from 'juno-agent/modules/memory/util';
import { provisionSlackAgent } from '../channels/slack/shared.js';

export const MARKER = '__migrations/apps-v1';

export interface AppsMigration {
  skipped: boolean;
  policies: number;
  stripped: number;
  dmRows: number;
}

export async function migrateApps(store: Store): Promise<AppsMigration> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, policies: 0, stripped: 0, dmRows: 0 };
  let policies = 0;
  let stripped = 0;
  for (const connection of await listAll(store, 'connections')) {
    const level: unknown = Reflect.get(connection, 'permission');
    const ownerId = docOwner(connection);
    if (level === undefined || ownerId === undefined) continue;
    if (level === 'read_only') {
      for (const agent of await ownerAgents(store, ownerId)) {
        const appId = appIdOfConnection(connection);
        // An owner who already set the app for this agent keeps what they set.
        if ((await store.get('agentApps', agent.id + ':' + appId)) === null) {
          await setAgentApp(store, { ownerId, agentId: agent.id, appId, enabled: true, actionsPolicy: 'off' });
          policies += 1;
        }
      }
    }
    const { permission: _dropped, ...rest } = connection as typeof connection & { permission?: unknown };
    await store.put('connections', rest);
    stripped += 1;
  }
  let dmRows = 0;
  const channels = await listAll(store, 'channels');
  for (const installation of await listAll(store, 'channelInstallations')) {
    if (installation.kind !== 'slack') continue;
    const main = (await jobAgent(store, installation.ownerId))?.agent;
    if (main === undefined || channels.some((row) => row.installationId === installation.id && row.agentId === main.id)) continue;
    await provisionSlackAgent({ store }, installation, main, false);
    dmRows += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, policies, stripped, dmRows };
}
