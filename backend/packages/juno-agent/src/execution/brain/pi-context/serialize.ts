import type { Message } from '@earendil-works/pi-ai';
import type { TranscriptEntry } from '../../../contracts/index.js';
import { contentText } from '@earendil-works/pi-ai';
import { parseMessage } from '../messages.js';
export const TOOL_RESULT_MAX_CHARS = 2000;
export function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const skipped = text.length - maxChars;
  return text.slice(0, maxChars) + '\n\n[... ' + String(skipped) + ' more characters truncated]';
}
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const content = message.content;
      if (typeof content === 'string') {
        if (content.length > 0) parts.push('[User]: ' + content);
        continue;
      }
      const text = contentText(content, '');
      let images = 0;
      for (const block of content) {
        if (block.type === 'image') images += 1;
      }
      if (text.length > 0) parts.push('[User]: ' + text);
      if (images > 0) parts.push('[User image x' + String(images) + ']');
      continue;
    }
    if (message.role === 'toolResult') {
      const text = contentText(message.content, '');
      let images = 0;
      for (const block of message.content) {
        if (block.type === 'image') images += 1;
      }
      if (text.length > 0) parts.push('[Tool result]: ' + truncateForSummary(text, TOOL_RESULT_MAX_CHARS));
      if (images > 0) parts.push('[Tool result image x' + String(images) + ']');
      continue;
    }
    const thinking: string[] = [];
    const calls: string[] = [];
    for (const block of message.content) {
      if (block.type === 'thinking') thinking.push(block.thinking);
      else if (block.type === 'toolCall') {
        let args = '[unserializable]';
        try {
          const raw = JSON.stringify(block.arguments);
          if (typeof raw === 'string') args = raw;
        } catch {
          args = '[unserializable]';
        }
        calls.push(block.name + '(' + args + ')');
      }
    }
    if (thinking.length > 0) parts.push('[Assistant thinking]: ' + thinking.join('\n'));
    const text = contentText(message.content, '');
    if (text.length > 0) parts.push('[Assistant]: ' + text);
    if (calls.length > 0) parts.push('[Assistant tool calls]: ' + calls.join('; '));
  }
  return parts.join('\n\n');
}
export function renderTranscriptEntries(entries: TranscriptEntry[]): string {
  const messages: Message[] = [];
  for (const entry of entries) {
    try {
      messages.push(parseMessage(entry.message));
    } catch {
      continue;
    }
  }
  return serializeConversation(messages);
}
