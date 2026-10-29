/**
 * The meetings plugin: everything agentd contributes for live meetings, behind one registration.
 *  - the Google Meet watcher (the backend poller that follows each call; stopped when the plugin is disabled),
 *  - the meeting tools (meeting_join / leave / say / transcript), offered to agents with a computer or a Feishu channel,
 *  - the Feishu meeting port those tools use for the Lark path.
 * The Feishu invitation poller stays with the Feishu channel runner (channels/feishu-ws.ts); it shares the session layer.
 */
import { meetingPluginTools } from 'juno-agent/modules/tools/tools/meetingTools';
import { createMeetingPort } from '../channels/feishu/meeting.js';
import type { AgentdPlugin } from '../plugins/services.js';
import { meetDepsOf, startMeetWatcher } from './meet.js';

export const meetingsPlugin: AgentdPlugin = {
  name: 'meetings',
  inject: ['store', 'enqueuer', 'computerd', 'computer'],
  apply(ctx) {
    const store = ctx.service('store');
    const enqueuer = ctx.service('enqueuer');
    const computerd = ctx.service('computerd');
    const computer = ctx.service('computer');
    const deps = meetDepsOf({ store, enqueuer, computerd });
    // One watcher per deployment: an execution-only worker registers the meeting tools but does not open another.
    ctx.singleton(() => {
      const watcher = startMeetWatcher(deps);
      return () => watcher.stop();
    }, 'meet watcher');
    const port = createMeetingPort({ store, enqueuer, home: computerd.home, meet: deps.meet });
    for (const { tool, ...options } of meetingPluginTools(port, computer === undefined ? undefined : () => computer)) ctx.tools.register(tool, options);
  },
};
