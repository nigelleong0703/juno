/**
 * What Slack offers its own apps, beyond messages (BACKEND 6.8). Each piece is checked against the Slack docs it cites:
 *  - the AI-app surface: a new assistant thread gets suggested prompts (`assistant_thread_started`, `assistant.threads.setSuggestedPrompts`,
 *    docs.slack.dev/reference/events/assistant_thread_started) and, while a run works, the "is thinking…" status
 *    (`assistant.threads.setStatus`, scope chat:write; see channels/working.ts);
 *  - the App Home tab: the agent's open tasks and routines, read-only (`app_home_opened`, `views.publish`, docs.slack.dev/reference/methods/views.publish);
 *  - the `/juno` slash command and the "Ask Juno about this" message shortcut (docs.slack.dev/interactivity/implementing-slash-commands,
 *    implementing-shortcuts: both must be acknowledged within 3 seconds, so the answer is admitted after the acknowledgement);
 *  - joining a channel (`member_joined_channel` of the bot, docs.slack.dev/reference/events/member_joined_channel): the earlier messages are read.
 * The manifest and scopes of the shared app are in shared.ts.
 */
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import type { ChannelInstallation, ChannelRow } from '@agent-desktop/contracts';
import { postSlackMessage, setSlackSuggestedPrompts, slackJson, type SuggestedPrompt } from '@agent-desktop/channels/slack/status';
import { listLiveWork } from 'juno-agent/modules/tasks/work-view';
import { jobAgent } from 'juno-agent/modules/memory/jobs/agent';
import { admitChannelEvent, type AdmitDeps } from '../../routes/channels.js';
import { docOwnerId } from '../../routes/relationships.js';
import { backfillGroup, claimBackfill } from '../backfill.js';

export const SLACK_ASK_SHORTCUT = 'juno_ask_about_this';

export const SLACK_SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  { title: 'What is on my plate?', message: 'What is on my plate today?' },
  { title: 'Summarize a channel', message: 'Summarize what happened in the channels you are in this week.' },
  { title: 'Draft something', message: 'Help me draft a message.' },
];

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** The agents enabled in a workspace, and the one a DM or an unnamed request goes to (the owner's main agent when it is enabled here). */
export async function workspaceRows(deps: AdmitDeps, ownerId: string, installation: ChannelInstallation): Promise<{ rows: ChannelRow[]; dmRow: ChannelRow | undefined }> {
  const page = await deps.store.list('channels', { where: { kind: 'slack' }, limit: 500 });
  const rows = page.items.filter((row) => row.installationId === installation.id);
  const main = (await jobAgent(deps.store, ownerId))?.agent;
  return { rows, dmRow: rows.find((row) => row.agentId === main?.id) ?? rows[0] };
}

/** The Home tab: what the agent has open (tasks and routines), for the owner; everyone else gets a line on how to reach it. */
async function homeView(deps: AdmitDeps, row: ChannelRow, forOwner: boolean): Promise<Record<string, unknown>> {
  const agent = await deps.store.get('agents', row.agentId);
  const name = agent?.name ?? 'Juno';
  const blocks: Array<Record<string, unknown>> = [{ type: 'header', text: { type: 'plain_text', text: name } }];
  if (!forOwner) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Send me a direct message, or mention me in a channel.' } });
    return { type: 'home', blocks };
  }
  const tasks = (await listLiveWork(deps.store, { agentId: row.agentId })).slice(0, 10);
  const routines = (await deps.store.list('routines', { where: { agentId: row.agentId }, limit: 50 })).items.filter((routine) => routine.enabled && routine.monitor === undefined).slice(0, 10);
  const lines = (items: string[], none: string): string => (items.length === 0 ? none : items.map((line) => '• ' + line).join('\n'));
  blocks.push(
    { type: 'section', text: { type: 'mrkdwn', text: '*Open tasks*\n' + lines(tasks.map((task) => task.title + (task.progress === undefined ? '' : ' — ' + task.progress)), 'Nothing open.') } },
    { type: 'section', text: { type: 'mrkdwn', text: '*Routines*\n' + lines(routines.map((routine) => routine.name), 'No routines.') } },
  );
  const appUrl = str(process.env['JUNO_APP_URL']);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: appUrl === undefined ? 'Open the Juno app to change any of this.' : '<' + appUrl + '|Open Juno> to change any of this.' }] });
  return { type: 'home', blocks };
}

/**
 * The events that are not messages. True when the event was one of them (handled, or ignored on purpose), so the message routing
 * does not see it.
 */
export async function handleSlackNativeEvent(
  deps: AdmitDeps,
  installation: ChannelInstallation,
  rows: ChannelRow[],
  dmRow: ChannelRow | undefined,
  event: Record<string, unknown>,
): Promise<boolean> {
  const type = str(event['type']);
  const ownerId = docOwnerId(installation);
  if (ownerId === undefined) return false;
  const token = decryptSecret(installation.botToken);
  const fetchFn = deps.channelFetch ?? fetch;
  if (type === 'assistant_thread_started') {
    const thread = record(event['assistant_thread']);
    const channel = str(thread['channel_id']);
    const ts = str(thread['thread_ts']);
    if (channel !== undefined && ts !== undefined) await setSlackSuggestedPrompts(fetchFn, token, channel, ts, SLACK_SUGGESTED_PROMPTS);
    return true;
  }
  if (type === 'app_home_opened') {
    const user = str(event['user']);
    if (user !== undefined && str(event['tab']) !== 'messages' && dmRow !== undefined) {
      const view = await homeView(deps, dmRow, user === dmRow.ownerExternalId);
      await slackJson(fetchFn, token, 'views.publish', { user_id: user, view });
    }
    return true;
  }
  if (type === 'member_joined_channel') {
    const channel = str(event['channel']);
    // Only the bot joining: every agent of the workspace reads the channel's earlier messages once.
    if (channel !== undefined && str(event['user']) === installation.botUserId) {
      for (const row of rows) if (await claimBackfill(deps, row, channel)) void backfillGroup(deps, ownerId, row, { chatId: channel, chatType: 'group' });
    }
    return true;
  }
  return false;
}

/** `/juno [agent] what you need`: the agent named first (by its handle or name) or the main one, answering in a thread under a line that says who asked. */
export async function handleSlackCommand(deps: AdmitDeps, ownerId: string, form: Record<string, unknown>): Promise<{ response: Record<string, unknown>; done?: Promise<void> }> {
  const teamId = str(form['team_id']);
  const installation = teamId === undefined ? null : await deps.store.get('channelInstallations', 'slack:' + teamId);
  if (installation === null || docOwnerId(installation) !== ownerId) return { response: { response_type: 'ephemeral', text: 'This workspace is not connected to Juno.' } };
  const text = (str(form['text']) ?? '').trim();
  const { rows, dmRow } = await workspaceRows(deps, ownerId, installation);
  const first = text.split(/\s+/)[0]?.replace(/^@/, '').toLowerCase() ?? '';
  const named = rows.find((row) => first !== '' && (row.handle?.toLowerCase() === first || row.displayName?.toLowerCase() === first));
  const row = named ?? dmRow;
  const ask = (named === undefined ? text : text.slice(text.indexOf(first) + first.length + (text.startsWith('@') ? 1 : 0))).trim();
  if (row === undefined || ask === '') return { response: { response_type: 'ephemeral', text: 'Tell me what you need: `/juno what is on my plate today?`' } };
  const channel = str(form['channel_id']);
  const user = str(form['user_id']);
  if (channel === undefined || user === undefined) return { response: { response_type: 'ephemeral', text: 'Slack did not say where this came from.' } };
  const token = decryptSecret(installation.botToken);
  const fetchFn = deps.channelFetch ?? fetch;
  const done = (async (): Promise<void> => {
    const direct = channel.startsWith('D');
    // In a channel the question becomes a message the thread hangs under; the bot must be in the channel to post it.
    const anchor = direct ? undefined : await postSlackMessage(fetchFn, token, { channel, text: '<@' + user + '> asked: ' + ask });
    if (anchor !== undefined && 'error' in anchor) {
      const back = str(form['response_url']);
      if (back !== undefined) await fetchFn(back, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', text: 'I could not post here (' + anchor.error + '). Invite me to the channel first.' }) }).catch(() => undefined);
      return;
    }
    const ts = anchor?.ts;
    await admitChannelEvent(deps, ownerId, 'slack', row.channelId, {
      chatId: channel,
      chatType: direct ? 'private' : 'group',
      threadId: ts === undefined ? channel : channel + ':' + ts,
      externalMessageId: ts === undefined ? 'cmd:' + (str(form['trigger_id']) ?? String(Date.now())) : channel + ':' + ts,
      from: { id: user, name: '' },
      text: ask,
    });
  })().catch(() => undefined);
  return { response: { response_type: 'ephemeral', text: 'On it.' }, done };
}

/** The "Ask Juno about this" message shortcut (`message_action`): the message goes to the agent as the question, answered in the message's thread. */
export async function handleSlackShortcut(deps: AdmitDeps, ownerId: string, payload: Record<string, unknown>): Promise<void> {
  if (payload['type'] !== 'message_action' || payload['callback_id'] !== SLACK_ASK_SHORTCUT) return;
  const teamId = str(record(payload['team'])['id']);
  const installation = teamId === undefined ? null : await deps.store.get('channelInstallations', 'slack:' + teamId);
  if (installation === null || docOwnerId(installation) !== ownerId) return;
  const { dmRow } = await workspaceRows(deps, ownerId, installation);
  const channel = str(record(payload['channel'])['id']);
  const user = str(record(payload['user'])['id']);
  const message = record(payload['message']);
  const ts = str(message['ts']);
  const text = str(message['text']);
  if (dmRow === undefined || channel === undefined || user === undefined || ts === undefined || text === undefined) return;
  const direct = channel.startsWith('D');
  const thread = str(message['thread_ts']) ?? ts;
  await admitChannelEvent(deps, ownerId, 'slack', dmRow.channelId, {
    chatId: channel,
    chatType: direct ? 'private' : 'group',
    threadId: direct ? channel : channel + ':' + thread,
    externalMessageId: 'sc:' + channel + ':' + ts + ':' + (str(payload['trigger_id']) ?? ''),
    from: { id: user, name: '' },
    text: 'About this message: "' + text + '"',
  });
}
