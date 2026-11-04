const MODEL = process.env['E2E_REAL_MODEL'] ?? 'opencode-go/muse-spark-1.3-contributor';
const BASE_URL = process.env['E2E_MODEL_BASE_URL'] ?? 'http://127.0.0.1:10100/v1';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One chat completion from the same real model as the agent; retried a few times because a proxy sometimes drops a long request. */
async function llm(system: string, user: string): Promise<string> {
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content?.trim() ?? '';
      if (text !== '') return text;
      last = `empty answer (HTTP ${String(res.status)})`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000 * attempt);
  }
  throw new Error('the model did not answer: ' + last);
}

export interface Verdict { pass: boolean; reason: string }

/**
 * Judge an agent's reply against a rubric (same real model as the agent; JSON verdict). Judgment, not regexes:
 * `good` says what a good reply does, `bad` what fails it. `context` is what the judge needs to know about the situation.
 */
export async function judgeReply(input: { context: string; transcript: string; criterion: { good: string; bad: string } }): Promise<Verdict> {
  const system = [
    'You assess the replies of an AI assistant in a chat app. Judge only what the criterion asks, never anything else about the wording.',
    'You get the context, what a good reply does, what fails it, and the transcript (the person\'s messages and the assistant\'s replies, oldest first). Decide whether the assistant passed.',
    'Answer with one JSON object only: {"pass": true|false, "reason": "<two sentences quoting what decided it>"}.',
  ].join('\n');
  const user = [`Context:\n${input.context}`, `A good reply: ${input.criterion.good}`, `Failure: ${input.criterion.bad}`, `Transcript:\n${input.transcript}`].join('\n\n');
  const text = await llm(system, user);
  const json = /\{[\s\S]*\}/.exec(text)?.[0] ?? '';
  try {
    const parsed = JSON.parse(json) as { pass?: unknown; reason?: unknown };
    return { pass: parsed.pass === true, reason: typeof parsed.reason === 'string' ? parsed.reason : text.slice(0, 300) };
  } catch {
    return { pass: false, reason: 'the judge did not answer in JSON: ' + text.slice(0, 300) };
  }
}
