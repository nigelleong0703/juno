import type { Interaction, UserScript } from './types';

/** A pending request as the API returns it (the parts the scripted user reads). */
export interface PendingRequest {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  createdAt?: string;
  payload: Record<string, any>;
}

export interface Decision {
  body: { action: 'approve' | 'deny' | 'answer'; scope?: 'once'; answers?: Record<string, string>; note?: string };
  interaction: Omit<Interaction, 'requestId' | 'at'>;
  /** Used if the API refuses `body` (e.g. an answer that is not one of the options). */
  fallback?: Decision['body'];
}

/** The option with the lowest price in its text; undefined when the options carry no prices. */
function cheapest(options: string[]): string | undefined {
  const priced = options.map((o) => ({ o, price: Number((/[$£€]\s?(\d[\d,]*(?:\.\d+)?)/.exec(o) ?? /(\d[\d,]*(?:\.\d+)?)\s?(?:SGD|USD|dollars)/i.exec(o))?.[1]?.replace(/,/g, '')) })).filter((p) => Number.isFinite(p.price));
  return priced.length === options.length ? priced.sort((a, b) => a.price - b.price)[0]?.o : undefined;
}

type AskedField = { id: string; prompt: string; kind: string; options?: string[]; /** Choice labels by the wire value to answer with. */ values?: Map<string, string> };

/** A question's interactive block (BACKEND 8.7.1) as the fields a person fills in: a choices block answers with an option id. */
function askedFields(payload: Record<string, any>): AskedField[] {
  const blocks = (payload['ui']?.blocks ?? []) as Array<Record<string, any>>;
  const prompt = [payload['ui']?.title, ...blocks.filter((b) => b['type'] === 'text' || b['type'] === 'notice').map((b) => b['text']), ...blocks.filter((b) => b['type'] === 'facts').flatMap((b) => b['rows'].map((r: any) => `${r.label}: ${r.value}`))].filter(Boolean).join(' ');
  return blocks.flatMap((b): AskedField[] => {
    if (b['type'] === 'choices') {
      return [{ id: b['id'], prompt, kind: 'choice', options: b['options'].map((o: any) => o.label), values: new Map(b['options'].map((o: any) => [o.label, o.id])) }];
    }
    if (b['type'] === 'fields') return b['fields'].map((f: any) => ({ id: f.id, prompt: `${prompt} ${f.label}`, kind: f.kind === 'select' ? 'choice' : f.kind, ...(f.options === undefined ? {} : { options: f.options }) }));
    return [];
  });
}

const describeRequest = (r: PendingRequest): string => {
  const p = r.payload;
  const parts = [r.title, r.summary, p['action'], p['why'], p['target'], p['site'], p['reason']];
  if (p['purchase'] !== undefined) parts.push('purchase ' + JSON.stringify(p['purchase']));
  if (p['ui'] !== undefined) parts.push(...askedFields(p).map((f) => f.prompt));
  return parts.filter((x) => typeof x === 'string' && x.length > 0).join(' | ');
};

/** What the written script says to do with one request: the same choices the apps give a person (answer / approve once / decline). */
export function decide(script: UserScript, request: PendingRequest): Decision {
  const text = describeRequest(request);
  const base = { kind: request.kind, title: request.title, text, purchase: request.payload['purchase'] !== undefined };
  switch (request.kind) {
    case 'question': {
      const answers: Record<string, string> = {};
      let rule = 'fallbackReply';
      for (const field of askedFields(request.payload)) {
        const haystack = `${field.prompt} ${(field.options ?? []).join(' ')}`;
        const hit = script.replies?.find((r) => r.match.test(haystack));
        let answer = hit?.answer ?? script.fallbackReply;
        if (hit !== undefined) rule = String(hit.match);
        if (field.options !== undefined && field.options.length > 0) {
          const exact = field.options.find((o) => o.toLowerCase() === answer.toLowerCase());
          const loose = field.options.find((o) => answer.toLowerCase().includes(o.toLowerCase()) || o.toLowerCase().includes(answer.toLowerCase()));
          answer = exact ?? (/cheap|lowest|least|smallest|base/i.test(answer) ? cheapest(field.options) : undefined) ?? loose ?? field.options[0] ?? answer;
        } else if (field.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(answer)) answer = '1';
        else if (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(answer)) answer = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        answers[field.id] = field.values?.get(answer) ?? answer;
      }
      return { body: { action: 'answer', answers }, interaction: { ...base, action: 'answer', rule, answers } };
    }
    case 'signin':
    case 'computer': {
      if (script.takeover !== undefined) {
        return { body: { action: 'deny', note: script.takeover }, interaction: { ...base, action: 'deny', rule: 'takeover', note: script.takeover } };
      }
      return { body: { action: 'deny', note: 'I cannot take over now.' }, interaction: { ...base, action: 'deny', rule: 'no takeover script', note: 'I cannot take over now.' } };
    }
    case 'secure_input':
    case 'admin':
      return { body: { action: 'deny', note: 'Not available in this test.' }, interaction: { ...base, action: 'deny', rule: request.kind, note: 'Not available in this test.' } };
    default: {
      const rule = script.approvals?.find((r) =>
        (r.kind === undefined || r.kind === request.kind) &&
        (r.text === undefined || r.text.test(text)) &&
        (r.purchase === undefined || r.purchase === base.purchase));
      const action = rule?.action ?? script.defaultApproval;
      const body: Decision['body'] = action === 'approve' ? { action: 'approve', scope: 'once' } : { action: 'deny', note: 'Declined by the test script.' };
      return { body, interaction: { ...base, action, rule: rule?.name ?? 'default', ...(body.note === undefined ? {} : { note: body.note }) } };
    }
  }
}
