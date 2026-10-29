import type { TranscriptEntry } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { parseMessage } from '../messages.js';
export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}
export const ESTIMATED_IMAGE_CHARS = 4800;
const CHARS_PER_TOKEN = 4;
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}
function contentChars(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
    else if (block.type === 'image') chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}
export function estimateCutTokens(message: Message): number {
  if (message.role === 'system') {
    let chars = contentChars(message.content);
    if (message.sections !== undefined) {
      const values = Object.values(message.sections);
      for (const value of values) {
        if (typeof value === 'string') chars += value.length;
      }
    }
    if (message.toolsAdded !== undefined) chars += safeStringify(message.toolsAdded).length;
    if (message.toolsRemoved !== undefined) chars += safeStringify(message.toolsRemoved).length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  if (message.role === 'user') return Math.ceil(contentChars(message.content) / CHARS_PER_TOKEN);
  if (message.role === 'toolResult') return Math.ceil(contentChars(message.content) / CHARS_PER_TOKEN);
  let chars = 0;
  for (const block of message.content) {
    if (block.type === 'text') chars += block.text.length;
    else if (block.type === 'thinking') chars += block.thinking.length;
    else chars += block.name.length + safeStringify(block.arguments).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
function parseEntryMessage(entry: TranscriptEntry): Message | undefined {
  try {
    return parseMessage(entry.message);
  } catch {
    return undefined;
  }
}
function entryMessages(entry: TranscriptEntry): Message[] {
  const parsed = parseEntryMessage(entry);
  return parsed === undefined ? [] : [parsed];
}
export function isCutPointMessage(message: Message): boolean {
  if (message.role === 'user') return true;
  if (message.role === 'assistant') return true;
  return false;
}
export function isTurnStartMessage(message: Message): boolean {
  if (message.role === 'user') return true;
  return false;
}
function isTurnStartEntry(entry: TranscriptEntry): boolean {
  const messages = entryMessages(entry);
  for (const message of messages) {
    if (isTurnStartMessage(message)) return true;
  }
  return false;
}
export function findValidCutPoints(entries: TranscriptEntry[], startIndex: number, endIndex: number): number[] {
  const cuts: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const messages = entryMessages(entry);
    let valid = false;
    for (const message of messages) {
      if (isCutPointMessage(message)) valid = true;
    }
    if (valid) cuts.push(i);
  }
  return cuts;
}
export function findTurnStartIndex(entries: TranscriptEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (isTurnStartEntry(entry)) return i;
  }
  return -1;
}
export function findCutPoint(entries: TranscriptEntry[], startIndex: number, endIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulated = 0;
  let exceeded = false;
  let cutIndex = startIndex;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const messages = entryMessages(entry);
    let tokens = 0;
    for (const message of messages) tokens += estimateCutTokens(message);
    if (tokens === 0) continue;
    accumulated += tokens;
    if (accumulated >= keepRecentTokens) {
      exceeded = true;
      let next: number | undefined;
      for (const candidate of cutPoints) {
        if (candidate >= i) {
          next = candidate;
          break;
        }
      }
      if (next !== undefined) cutIndex = next;
      else {
        const lastCut = cutPoints[cutPoints.length - 1];
        if (lastCut !== undefined) cutIndex = lastCut;
      }
      break;
    }
  }
  if (exceeded === false) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  while (cutIndex > startIndex) {
    const prev = entries[cutIndex - 1];
    if (prev === undefined) break;
    if (entryMessages(prev).length > 0) break;
    cutIndex -= 1;
  }
  const cutEntry = entries[cutIndex];
  if (cutEntry === undefined) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  if (isTurnStartEntry(cutEntry)) return { firstKeptEntryIndex: cutIndex, turnStartIndex: -1, isSplitTurn: false };
  const turnStart = findTurnStartIndex(entries, cutIndex, startIndex);
  return { firstKeptEntryIndex: cutIndex, turnStartIndex: turnStart, isSplitTurn: turnStart !== -1 };
}
