/**
 * What not to offer again (BACKEND §5.10). An idea is the same as an earlier one when their keys (topic + what would be done)
 * match, whatever the wording. How long an earlier idea blocks depends on how it ended: handled (accepted, done, started) never
 * comes back; dismissed 60 days; snoozed ("not now") 14 days for the idea and its topic; shown and ignored 14 days, then one
 * re-offer (a second ignore blocks 60 days); still waiting blocks as long as it waits.
 */
import type { Idea } from '@agent-desktop/public-contracts';

export const DISMISS_DAYS = 60;
export const SNOOZE_DAYS = 14;
export const IGNORED_DAYS = 14;
/** How far back the model is shown what was offered. */
export const LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A topic or title reduced to letters and digits, so wording and punctuation changes do not hide a repeat. */
export const normalizeKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The stable key of an idea: its topic and the one verb for what the assistant would do ("draft", "book", "summarise"). */
export const ideaKey = (topic: string, verb?: string): string => normalizeKey(topic) + '|' + normalizeKey(verb ?? '');

type Candidate = Pick<Idea, 'text' | 'topic' | 'key'>;
export type IdeaFacts = Pick<Idea, 'text' | 'topic' | 'status' | 'updatedAt' | 'key' | 'outcome'>;

const keyOf = (idea: Candidate): string => idea.key ?? ideaKey(idea.topic ?? idea.text);
const topicOf = (idea: Candidate): string => keyOf(idea).split('|')[0] ?? '';
const verbOf = (idea: Candidate): string => keyOf(idea).split('|')[1] ?? '';

/** Whether two ideas are the same: equal keys when both name the action, else the same topic or the same title (ideas from before keys). */
export function sameIdea(a: Candidate, b: Candidate): boolean {
  if (verbOf(a) !== '' && verbOf(b) !== '') return keyOf(a) === keyOf(b);
  const topicA = topicOf(a);
  return (topicA !== '' && topicA === topicOf(b)) || normalizeKey(a.text) === normalizeKey(b.text);
}

const ageDays = (idea: IdeaFacts, now: Date): number => (now.getTime() - Date.parse(idea.updatedAt)) / DAY_MS;

/** Why `candidate` may not be offered now (given every earlier idea of the owner and the topics snoozed from other places), or undefined when it may. */
export function blockedReason(candidate: Candidate, ideas: readonly IdeaFacts[], now: Date, snoozedTopics: readonly string[] = []): string | undefined {
  const topic = topicOf(candidate);
  const title = normalizeKey(candidate.text);
  for (const snoozed of snoozedTopics) {
    if (snoozed !== '' && (topic === snoozed || topic.includes(snoozed) || title.includes(snoozed))) return 'its topic was snoozed';
  }
  const ignoredCount = ideas.filter((idea) => idea.outcome === 'ignored' && sameIdea(candidate, idea)).length;
  for (const idea of ideas) {
    const age = ageDays(idea, now);
    if (idea.status === 'open' && sameIdea(candidate, idea)) return 'already waiting';
    if (idea.status === 'accepted' && sameIdea(candidate, idea)) return 'already handled';
    if (idea.status !== 'dismissed') continue;
    if (idea.outcome === 'not_now') {
      if (age < SNOOZE_DAYS && (sameIdea(candidate, idea) || (topic !== '' && topic === topicOf(idea)))) return 'snoozed for now';
    } else if (idea.outcome === 'ignored') {
      if (sameIdea(candidate, idea) && age < (ignoredCount >= 2 ? DISMISS_DAYS : IGNORED_DAYS)) return 'shown and ignored';
    } else if (sameIdea(candidate, idea) && age < DISMISS_DAYS) return 'dismissed';
  }
  return undefined;
}

/** How an earlier idea stands now, or undefined when it no longer blocks anything. */
function standing(idea: IdeaFacts, now: Date): string | undefined {
  if (idea.status === 'open') return 'waiting';
  if (idea.status === 'accepted') return 'handled';
  const age = ageDays(idea, now);
  if (idea.outcome === 'not_now') return age < SNOOZE_DAYS ? 'snoozed' : undefined;
  if (idea.outcome === 'ignored') return age < IGNORED_DAYS ? 'shown and ignored' : undefined;
  return age < DISMISS_DAYS ? 'dismissed' : undefined;
}

/** What the model is shown as not to be offered again: earlier ideas that still block and were offered (or are still waiting) in the look-back window. */
export function recentIdeas(ideas: readonly IdeaFacts[], now: Date): Array<IdeaFacts & { standing: string }> {
  return ideas.flatMap((idea) => {
    const state = standing(idea, now);
    return state === undefined || (state !== 'waiting' && ageDays(idea, now) >= LOOKBACK_DAYS) ? [] : [{ ...idea, standing: state }];
  });
}
