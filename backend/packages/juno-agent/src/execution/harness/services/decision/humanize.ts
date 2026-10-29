import type { ToolOrigin } from '../../../../contracts/index.js';
import { words } from '../../../../modules/mcp/tool-access.js';

/** The plain words a native tool's action goes by; a name not listed reads as its own words. */
const NATIVE_ACTIONS: Readonly<Record<string, string>> = {
  'shell.run': 'run a command on its computer',
  'shell.start': 'start a command on its computer',
  'files.read': 'read a file',
  'files.write': 'write a file',
  'files.edit': 'edit a file',
  'files.search': 'search its files',
  'browser.click': 'click on a page',
  'browser.type': 'type on a page',
  'browser.fill': 'fill in a page',
  'browser.advance': 'advance through a page',
  'browser.dialog': 'answer a page dialog',
  'browser.navigate': 'open a page',
  'browser.new_tab': 'open a page in a new tab',
  'computer.click': 'click on its screen',
  'computer.double_click': 'double-click on its screen',
  'computer.type': 'type on its screen',
  'computer.key': 'press a key on its screen',
  'computer.install_packages': 'install system packages',
  computer_copy: 'copy a file between its computers',
  agent_create: 'create an agent',
  agent_update: 'change an agent',
  conversation_create: 'create a group chat',
  send_file: 'send a file',
  send_message: 'send a message',
  post_to_room: 'post to a group chat',
  space_publish: 'publish an app',
  artifact_publish: 'publish a document',
  feed_post: 'post to the feed',
  document_create: 'start a document',
  document_propose: 'propose a change to a document',
  phone_calendar_list_calendars: 'list the calendars on your iPhone',
  phone_calendar_list_events: 'read your iPhone calendar',
  phone_calendar_create_event: 'add an event to your iPhone calendar',
  phone_calendar_update_event: 'change an event on your iPhone calendar',
  phone_calendar_delete_event: 'delete an event from your iPhone calendar',
  phone_reminders_list: 'read your iPhone reminders',
  phone_reminders_create: 'add a reminder on your iPhone',
  phone_reminders_update: 'change a reminder on your iPhone',
  phone_reminders_delete: 'delete a reminder on your iPhone',
  web_fetch: 'open a web address',
};

/** The same tools when a call is on the owner's Mac (My Mac). */
const MAC_ACTIONS: Readonly<Record<string, string>> = {
  'shell.run': 'run a command on your Mac',
  'shell.start': 'start a command on your Mac',
  'files.read': 'read a file on your Mac',
  'files.write': 'write a file on your Mac',
  'files.edit': 'edit a file on your Mac',
  'files.search': 'search files on your Mac',
  computer_copy: 'copy a file to or from your Mac',
  'computer.snapshot': 'look at',
  'computer.act': 'use',
  'computer.verify': 'check',
  mac_mail_send: 'send an email from your Mac',
  mac_mail_create_draft: 'save an email draft on your Mac',
  mac_calendar_create_event: 'add a calendar event on your Mac',
  mac_reminders_create: 'add a reminder on your Mac',
  mac_reminders_complete: 'complete a reminder on your Mac',
  mac_notes_create: 'create a note on your Mac',
  mac_notes_append: 'add text to a note on your Mac',
};

export interface ToolWords {
  /** The app or site a user knows it by ("Gmail"); absent for tools of the agent's own computer. */
  app?: string;
  /** What it does, lowercase words: "send email". */
  action: string;
}

/** A tool as a person would say it. An MCP tool shows the connection's name plus the server's tool name, never its model-facing name. */
export function toolWords(toolName: string, origin?: ToolOrigin, mac = false): ToolWords {
  if (origin !== undefined) return { app: origin.connectionName, action: words(origin.toolName).join(' ') || 'use a tool' };
  const known = (mac ? MAC_ACTIONS[toolName] : undefined) ?? NATIVE_ACTIONS[toolName];
  if (known !== undefined) return { action: known };
  return { action: toolName.replace(/[._]+/g, ' ').trim() || 'use a tool' };
}

/** "send email in Gmail" for a sentence; the same words the cards, rule descriptions and reasons use. */
export function toolPhrase(toolName: string, origin?: ToolOrigin, mac = false): string {
  const { app, action } = toolWords(toolName, origin, mac);
  return app === undefined ? action : `${action} in ${app}`;
}
