/**
 * Catching a promise the run never scheduled: a final reply that says the agent will remind, check or follow up later, in a run that set
 * nothing up, loses the promise when the run ends. The reply goes back to the model once (final-reply.ts) to schedule it or drop it.
 */

/** Once per run a reply that promises something later without a schedule is sent back to the model instead of being posted. */
export interface PromiseRetryBudget {
  used: boolean;
  /** The run's one send-back of a reply with a long unpunctuated stretch (see `unpunctuatedRun`). */
  punctuationUsed?: boolean;
}

/** What the agent says it will do itself: an action word after a first-person future opener. */
const ZH_ACTION = '(?:提醒|告诉|通知|跟进|看看|查一下|查查|加上|加进|发给|ping)';
const ZH_PROMISE = new RegExp(
  `(?:我(?:会|再|直接|就)|回头|晚点|稍后|到时候?|等[^，,。！？!?\\n]{0,10}(?:好了?|连上了?|之后|以后)[^，,。！？!?\\n]{0,4}我)[^，,。！？!?\\n]{0,12}?${ZH_ACTION}`,
);
const EN_PROMISE = /\bI(?:'ll|’ll| will)\s+(?:also\s+)?(?:remind|follow up|ping|let you know|get back|add (?:it|that|this)|check (?:back|in|again|tomorrow|later|tonight|next|on))\b/i;

/** A sentence that offers or asks is not a promise ("要我提醒你吗？", "want me to remind you?"). */
const OFFER = /吗|要我|需要我|想让我|是否|want me|would you like|shall I|should I|do you want/i;

/** Sentences with their closing punctuation kept, so a question mark can disqualify its sentence. */
const sentencesOf = (text: string): string[] => text.match(/[^。！？!?\n]+(?:[。！？!?]+|\n|$)|\n/g) ?? [];

/** The first promise phrase the reply makes about its own later action, or null. Deterministic and conservative. */
export function promisePhrase(text: string): string | null {
  for (const sentence of sentencesOf(text)) {
    if (/[？?]\s*$/.test(sentence) || OFFER.test(sentence)) continue;
    const found = ZH_PROMISE.exec(sentence) ?? EN_PROMISE.exec(sentence);
    if (found !== null) return found[0];
  }
  return null;
}

/** Tools that set something up for later: a calendar entry or reminder, a routine (state_update only creates routines), a timed wake. */
const SCHEDULING_TOOL = /^(?:schedule_(?:add|update)|wake_at|state_update)$|calendar_create|routine/;

/** Whether any of the run's finished steps scheduled something. */
export function scheduledSomething(steps: ReadonlyArray<{ tool?: string; status?: string }>): boolean {
  return steps.some((step) => step.status === 'completed' && step.tool !== undefined && SCHEDULING_TOOL.test(step.tool));
}

export const promiseRetryHint = (phrase: string): string =>
  `Your last reply was not posted: it says "${phrase}" but this run scheduled nothing, so the promise would be lost. Either set it up now with schedule_add (a repeating one: create_routine, find it with tool_search) at a sensible time and keep the reply saying when, or send the reply again without the promise.`;

/**
 * A stretch of Chinese with no mark at all, long enough that no natural clause runs that far ("卤肉饭加蛋大概700大卡蛋白20克炸南乳肉三块…"):
 * the model keeps dropping ，and 。 whatever the prompt says, and the owner cannot read it. Code, links and table cells are not text.
 */
const UNPUNCTUATED_CHARS = 30;
export function unpunctuatedRun(text: string): string | null {
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g, ' ');
  for (const run of prose.split(/[\s，,。.！!？?、；;：:（）()【】[\]「」“”"'‘’…—\-|*#>~/]+/)) {
    if (run.length >= UNPUNCTUATED_CHARS && /[\u4e00-\u9fff]/.test(run) && (run.match(/[\u4e00-\u9fff]/g)?.length ?? 0) >= UNPUNCTUATED_CHARS / 2) return run;
  }
  return null;
}

export const punctuationRetryHint = (run: string): string =>
  `Your last reply was not posted: "${run.slice(0, 40)}…" runs on with no punctuation and the person cannot read it. Send the same reply again with its ，、。？ in place (split long sentences), changing nothing else.`;
