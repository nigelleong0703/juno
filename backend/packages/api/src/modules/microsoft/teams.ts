/**
 * Microsoft Teams on Microsoft Graph, read only: chats and their recent messages, joined teams, channels and channel
 * messages. Delegated Teams scopes (ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All) need a tenant
 * admin's consent in many organisations; Chat.Read can usually be consented by the user. Personal Microsoft accounts have no Teams chats here.
 */
import { str, type HostedTool } from '../google/shared.js';
import { bodyText, listPage, MS_PAGE, MS_ZONE, none, size, when, zoneOf } from './shared.js';

export const TEAMS_SCOPES = ['Chat.Read', 'ChannelMessage.Read.All', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'offline_access'];

function messageLine(message: Record<string, unknown>, zone: string | undefined): string {
  const from = typeof message.from === 'object' && message.from !== null ? Reflect.get(message.from, 'user') : undefined;
  const name = typeof from === 'object' && from !== null ? String(Reflect.get(from, 'displayName') ?? '') : '';
  const text = bodyText(message.body, 2000);
  const subject = typeof message.subject === 'string' && message.subject !== '' ? '[' + message.subject + '] ' : '';
  return when(message.createdDateTime, zone) + ' ' + (name === '' ? '(system)' : name) + ': ' + subject + text.replace(/\n+/g, ' / ');
}

export const TEAMS_TOOLS: HostedTool[] = [
  {
    name: 'list_chats',
    title: 'List chats',
    description: "List the owner's Teams chats (1:1, group, meeting), most recently active first, with their members.",
    properties: { ...MS_PAGE, ...MS_ZONE },
    run: async (api, args) => {
      const { items, more } = await listPage(api, args, '/me/chats', { $top: size(args), $expand: 'members', $orderby: 'lastMessagePreview/createdDateTime desc' });
      const zone = zoneOf(args);
      return items.length === 0 ? none('chats') : items.map((chat) => {
        const members = (Array.isArray(chat.members) ? (chat.members as Record<string, unknown>[]) : []).map((member) => String(member.displayName ?? '')).filter((name) => name !== '').join(', ');
        const last = typeof chat.lastMessagePreview === 'object' && chat.lastMessagePreview !== null ? Reflect.get(chat.lastMessagePreview, 'createdDateTime') : undefined;
        return '[' + String(chat.id) + '] ' + String(chat.chatType) + (typeof chat.topic === 'string' && chat.topic !== '' ? ' "' + chat.topic + '"' : '') + ' | ' + members + (last === undefined ? '' : ' | last ' + when(last, zone));
      }).join('\n') + more;
    },
  },
  {
    name: 'get_chat_messages',
    title: 'Read a chat',
    description: 'Recent messages in a chat, newest first.',
    properties: { chatId: { type: 'string', description: 'Chat id from list_chats.' }, ...MS_PAGE, ...MS_ZONE },
    required: ['chatId'],
    run: async (api, args) => {
      const { items, more } = await listPage(api, args, '/me/chats/' + encodeURIComponent(str(args.chatId) ?? '') + '/messages', { $top: String(Math.min(50, Number(size(args)))), $orderby: 'createdDateTime desc' });
      const zone = zoneOf(args);
      return items.length === 0 ? none('messages') : items.map((message) => messageLine(message, zone)).join('\n') + more;
    },
  },
  {
    name: 'list_teams',
    title: 'List teams',
    description: 'List the teams the owner has joined.',
    properties: {},
    run: async (api) => {
      const { items } = await listPage(api, {}, '/me/joinedTeams', { $select: 'id,displayName,description' });
      return items.length === 0 ? none('teams') : items.map((team) => '[' + String(team.id) + '] ' + String(team.displayName)).join('\n');
    },
  },
  {
    name: 'list_channels',
    title: 'List channels',
    description: 'List the channels of a team.',
    properties: { teamId: { type: 'string', description: 'Team id from list_teams.' } },
    required: ['teamId'],
    run: async (api, args) => {
      const { items } = await listPage(api, {}, '/teams/' + encodeURIComponent(str(args.teamId) ?? '') + '/channels', { $select: 'id,displayName,membershipType' });
      return items.length === 0 ? none('channels') : items.map((channel) => '[' + String(channel.id) + '] ' + String(channel.displayName) + ' (' + String(channel.membershipType) + ')').join('\n');
    },
  },
  {
    name: 'get_channel_messages',
    title: 'Read a channel',
    description: 'Recent posts in a team channel, newest first (replies are not included).',
    properties: { teamId: { type: 'string', description: 'Team id from list_teams.' }, channelId: { type: 'string', description: 'Channel id from list_channels.' }, ...MS_PAGE, ...MS_ZONE },
    required: ['teamId', 'channelId'],
    run: async (api, args) => {
      const { items, more } = await listPage(api, args, '/teams/' + encodeURIComponent(str(args.teamId) ?? '') + '/channels/' + encodeURIComponent(str(args.channelId) ?? '') + '/messages', { $top: String(Math.min(50, Number(size(args)))) });
      const zone = zoneOf(args);
      return items.length === 0 ? none('messages') : items.map((message) => messageLine(message, zone)).join('\n') + more;
    },
  },
];
