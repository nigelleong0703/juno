/**
 * The Feishu / Lark plugin: the whole platform behind one registration (see registration.ts for the two layers).
 *  - communication layer: the connector (app credentials / device-flow app creation), the websocket runner (which also follows
 *    meeting invitations; the meeting tools themselves are the `meetings` plugin), outbound via packages/channels
 *    `feishuAdapter.transport`;
 *  - capability layer: `feishuAdapter.abilities` (reactions, history once the group-message scope is granted). Its grants
 *    (grants.ts) follow what Feishu answers to each call: `abilityOutcome` records them, `groupAdmitted` probes the group scope.
 */
import { FEISHU_SCOPE_GROUP_MESSAGES, FEISHU_SCOPE_REACTIONS } from '@agent-desktop/channels/feishu/abilities';
import { feishuAdapter } from '@agent-desktop/channels/sdk';
import type { AgentdPlugin } from '../../plugins/services.js';
import type { ChannelRegistration } from '../registration.js';
import { feishuConnector } from './connect.js';
import { recordFeishuOutcome, syncFeishuGroupGrant } from './grants.js';
import { feishuRunner } from './ws.js';

export const feishuPlatformRegistration: ChannelRegistration = {
  kind: 'feishu',
  adapter: feishuAdapter,
  connector: feishuConnector,
  runners: [feishuRunner],
  workingIndicator: true,
  abilityOutcome: (store, row, ability, result) => recordFeishuOutcome(store, row, ability === 'react' ? FEISHU_SCOPE_REACTIONS : FEISHU_SCOPE_GROUP_MESSAGES, result),
  groupAdmitted: (deps, row, chat) => syncFeishuGroupGrant(deps, row, chat),
};

export const feishuPlugin: AgentdPlugin = {
  name: 'feishu',
  apply(ctx) {
    ctx.channels.register(feishuPlatformRegistration);
  },
};
