import type { Message } from '@earendil-works/pi-ai';
import type { TranscriptEntry } from '../../../contracts/index.js';
import { harnessText } from '../../../modules/harness/loader.js';
import { parseMessage } from '../messages.js';
import { serializeConversation } from './serialize.js';
export function summaryMessage(summary: string): Message {
  return { role: 'user', content: harnessText('compaction.recap_message', { recap: summary }), timestamp: Date.now() };
}
/** The user's own words before the cut, kept verbatim ahead of the summary (what the user asked is never paraphrased away). */
export function recentUsersMessage(recentUsers: string[]): Message {
  return { role: 'user', content: harnessText('compaction.recent_users', { messages: recentUsers.join('\n---\n') }), timestamp: Date.now() };
}
export function buildProjectedMessages(system: Message | undefined, summary: string | undefined, kept: TranscriptEntry[], recentUsers?: string[]): Message[] {
  const out: Message[] = [];
  if (system !== undefined) out.push(system);
  if (recentUsers !== undefined && recentUsers.length > 0) out.push(recentUsersMessage(recentUsers));
  if (summary !== undefined) out.push(summaryMessage(summary));
  for (const entry of kept) {
    out.push(parseMessage(entry.message));
  }
  return out;
}
export function buildSummaryRequestMessage(older: TranscriptEntry[], previousSummary: string | undefined): Message {
  // The summary instruction ends with the dated topic index both summary prompts require; the two units join with one space.
  const parts: string[] = [harnessText('compaction.handoff') + ' ' + harnessText('compaction.topics_by_date')];
  if (previousSummary !== undefined && previousSummary.length > 0) {
    parts.push(harnessText('compaction.merge_earlier', { previous: previousSummary }));
  }
  // Older turns carry no dates of their own, so a [YYYY-MM-DD] line marks each change of calendar day.
  const days: Array<{ day: string; messages: Message[] }> = [];
  for (const entry of older) {
    try {
      const parsed = parseMessage(entry.message);
      if (parsed.role === 'system') continue;
      const day = entry.at.slice(0, 10);
      const last = days[days.length - 1];
      if (last !== undefined && last.day === day) last.messages.push(parsed);
      else days.push({ day, messages: [parsed] });
    } catch {
      continue;
    }
  }
  parts.push(harnessText('compaction.earlier_turns', { turns: days.map(group => '[' + group.day + ']\n' + serializeConversation(group.messages)).join('\n\n') }));
  return { role: 'user', content: parts.join('\n\n'), timestamp: Date.now() };
}
