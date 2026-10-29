// The `systemone` wire: TypeSafe's Jev API (POST {baseUrl}/v1/systemone) and anything that speaks it (DigitalOcean,
// LiteLLM, ZenMux, a self-hosted open model). The only file that knows this JSON.
//
// What this is based on (no TypeSafe account was available, so nothing here was run against the live service; TypeSafe
// says the shape may still change during early access). Three independent third-party docs show the same request and
// response bodies, and one of them is TypeSafe's own gateway pass-through:
//   https://docs.digitalocean.com/products/inference/how-to/use-system-one-api/index.html.md  (noul, choice, score)
//   https://zenmux.ai/docs/api/typesafe/systemone                                            (all three, field table)
//   https://docs.litellm.ai/docs/pass_through/typesafe                                        (choice, TypeSafe body unchanged)
// Request:  { model, state, questions: { name: { type, instructions, criteria } } } with Authorization: Bearer.
//           criteria: choice = { option: description }, score = ordered string[] (>= 2), noul = optional.
// Response: { model, answers: { name: { type:'noul', noul } | { type:'choice', choice, probabilities, confidence }
//           | { type:'score', score, legend, probabilities: {"0":p,...}, confidence } }, usage }.
// The error body is not documented anywhere; any non-2xx is just an error here.
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer, SystemOne, SystemOneAnswer, SystemOneQuestion, SystemOneAskOptions } from '../../ports/system-one/index.js';

export interface JevEndpoint {
  /** Endpoint root; `/v1/systemone` is appended unless the URL already ends with it. */
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const HASHED_ATTRIBUTION_ID = /^juno-[0-9a-f]{32}$/;

function requestBody(endpoint: JevEndpoint, state: string, questions: Record<string, SystemOneQuestion>, options?: SystemOneAskOptions): string {
  const wire = Object.fromEntries(Object.entries(questions).map(([name, q]) => [
    name,
    q.type === 'noul' ? { type: 'noul', instructions: q.instructions }
      : q.type === 'choice' ? { type: 'choice', instructions: q.instructions, criteria: q.options }
        : { type: 'score', instructions: q.instructions, criteria: q.levels },
  ]));
  const nativeState: unknown = options?.stateEncoding === 'json' ? JSON.parse(state) : state;
  if (options?.stateEncoding === 'json' && !isRecord(nativeState)) throw new Error('Structured System One state must be an object');
  return JSON.stringify({ model: endpoint.modelId, state: nativeState, questions: wire });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('System One answer has an invalid probability');
  return value;
}

function parseAnswer(name: string, question: SystemOneQuestion, raw: unknown): SystemOneAnswer {
  if (!isRecord(raw) || raw['type'] !== question.type) throw new Error(`System One answer "${name}" is missing or of the wrong type`);
  if (question.type === 'noul') return { type: 'noul', probability: probability(raw['noul']) } satisfies NoulAnswer;
  const confidence = probability(raw['confidence']);
  const given = raw['probabilities'];
  if (!isRecord(given)) throw new Error(`System One answer "${name}" has no probabilities`);
  if (question.type === 'choice') {
    const options = Object.keys(question.options);
    for (const key of Object.keys(given)) if (!options.includes(key)) throw new Error(`System One answer "${name}" names an unknown option`);
    const probabilities = Object.fromEntries(options.map((option) => [option, given[option] === undefined ? 0 : probability(given[option])]));
    const choice = raw['choice'];
    if (typeof choice !== 'string' || !options.includes(choice)) throw new Error(`System One answer "${name}" chose an unknown option`);
    return { type: 'choice', choice, probabilities, confidence } satisfies ChoiceAnswer;
  }
  const probabilities = question.levels.map((_, index) => (given[String(index)] === undefined ? 0 : probability(given[String(index)])));
  const score = raw['score'];
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.levels.length - 1) throw new Error(`System One answer "${name}" has an invalid score`);
  return { type: 'score', score, probabilities, confidence } satisfies ScoreAnswer;
}

/** The System One port over a Jev-compatible endpoint. `fetchFn` is the SSRF-guarded client for owner-added endpoints. */
export function createJevSystemOne(endpoint: JevEndpoint, fetchFn: typeof fetch = fetch): SystemOne {
  const url = /\/v1\/systemone\/?$/.test(endpoint.baseUrl) ? endpoint.baseUrl : endpoint.baseUrl.replace(/\/+$/, '') + '/v1/systemone';
  return {
    async ask(state, questions, signal, options) {
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: 'Bearer ' + endpoint.apiKey };
      if (options?.sessionId !== undefined && HASHED_ATTRIBUTION_ID.test(options.sessionId)) headers['session-id'] = options.sessionId;
      if (options?.requestId !== undefined && HASHED_ATTRIBUTION_ID.test(options.requestId)) headers['x-client-request-id'] = options.requestId;
      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: requestBody(endpoint, state, questions, options),
        redirect: 'manual',
        signal,
      });
      if (!response.ok) throw new Error(`System One endpoint answered ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('System One response is too large');
      const body: unknown = JSON.parse(text);
      const answers = isRecord(body) ? body['answers'] : undefined;
      if (!isRecord(answers)) throw new Error('System One response has no answers');
      return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, parseAnswer(name, question, answers[name])]));
    },
  };
}
