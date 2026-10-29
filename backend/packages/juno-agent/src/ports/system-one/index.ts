// The System One port: typed decisions instead of generated text (BACKEND §10.14). The caller gives a state (the
// context, untrusted text included) and named questions; the model answers each with probabilities. Adapters live in
// execution/brain/: `system-one-jev.ts` (the `systemone` wire) and `system-one-emulation.ts` (a chat model asked the same
// questions). An adapter throws when it cannot give an answer for every question; callers treat that as "no decision".

/** Yes/no: the answer is P(true). */
export interface NoulQuestion { type: 'noul'; instructions: string }
/** One of several options; `options` maps each option name to what it means. */
export interface ChoiceQuestion { type: 'choice'; instructions: string; options: Record<string, string | null> }
/** An ordered rubric; `levels` runs from lowest to highest, level i is `levels[i]`. */
export interface ScoreQuestion { type: 'score'; instructions: string; levels: readonly string[] }
export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer { type: 'noul'; probability: number }
/** `probabilities` has one entry per option and sums to about 1; `choice` is the most probable option. */
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
/** `score` is the probability-weighted level index; `probabilities[i]` belongs to `levels[i]`. */
export interface ScoreAnswer { type: 'score'; score: number; probabilities: number[]; confidence: number }
export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneAnswers = Record<string, SystemOneAnswer>;

/** Optional native-call provenance. Ids must already be one-way hashes, never raw run or session ids. */
export interface SystemOneAskOptions {
  allowEmulation?: boolean;
  /** Native transport decodes the supplied JSON text into a structured state object. Default: plain text. */
  stateEncoding?: 'json';
  /** Stable per-conversation affinity, formatted `juno-` plus 32 lowercase hex characters. */
  sessionId?: string;
  /** Stable per-run request attribution, formatted `juno-` plus 32 lowercase hex characters. */
  requestId?: string;
}

export interface SystemOne {
  // Answers every question (by name) or throws; null when no System One model is available.
  // Discovery passes allowEmulation false for a native-only decision: the brain then
  // returns null instead of spending a hidden fast-model call. Default (omitted) keeps
  // the existing emulation fallback for purchase and safety callers. Native adapters use
  // only checked hash attribution ids from options; three-argument stubs stay compatible.
  ask(state: string, questions: Record<string, SystemOneQuestion>, signal: AbortSignal, options?: SystemOneAskOptions): Promise<SystemOneAnswers | null>;
}

/** The named answer when it is a choice answer; undefined when missing or of another type. */
export function choiceAnswer(answers: SystemOneAnswers | null | undefined, name: string): ChoiceAnswer | undefined {
  const answer = answers?.[name];
  return answer?.type === 'choice' ? answer : undefined;
}
