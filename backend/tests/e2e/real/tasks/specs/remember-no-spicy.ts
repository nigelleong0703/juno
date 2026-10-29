import { lastReply } from '../observe';
import { verdict, type CheckResult, type TaskSpec } from '../types';
import { commonChecks } from './common';

/** Dishes that are spicy by nature, and the plain words. A bare "spicy" is fine only inside a refusal ("nothing spicy"). */
export const SPICY_DISHES = ['mala', 'szechuan', 'sichuan', 'sambal', 'chili crab', 'chilli crab', 'tom yum', 'vindaloo', 'kimchi jjigae', 'buffalo wings', 'jalapeno', 'jalapeño', 'hot pot', 'hotpot', 'curry laksa', 'spicy tuna', 'extra spicy', 'sriracha', 'tteokbokki', 'dan dan', 'mapo'];
const NEGATION = /\b(no|not|non|without|avoid(ing|ed)?|skip|none|isn'?t|don'?t|doesn'?t|won'?t|never|free of|mild|steer clear)\b/i;

export function spicyRecommendations(reply: string): string[] {
  const lower = reply.toLowerCase();
  const hits = SPICY_DISHES.filter((dish) => lower.includes(dish));
  const sentences = reply.split(/(?<=[.!?\n])\s+/).filter((s) => /\b(spicy|chili|chilli)\b/i.test(s) && !NEGATION.test(s));
  return [...hits, ...sentences.map((s) => s.trim().slice(0, 80))];
}

export const rememberNoSpicy: TaskSpec = {
  id: 'remember-no-spicy',
  title: 'Memory: "I don\'t eat spicy food" survives the hourly job into a new conversation',
  timeoutMs: 900_000,
  turns: [
    { message: "Remember I don't eat spicy food.", afterTurn: (env) => env.runMemoryJob() },
    { message: 'Recommend a dinner for tonight.', newConversation: true },
  ],
  user: { fallbackReply: 'anything is fine, pick one', defaultApproval: 'approve', replies: [{ match: /./, answer: 'anything is fine, pick one' }] },
  checks: [
    (o) => commonChecks(o),
    async (_o, env): Promise<CheckResult[]> => {
      // The hourly job files a claim by its target: long-term facts in MEMORY.md, preferences in memory/bank/*.md (BACKEND 5.4).
      const files: Array<{ path: string; content: string }> = [];
      for (const path of ['MEMORY.md', 'memory/bank/']) files.push(...(((await env.api('GET', `/v1/home?path=${encodeURIComponent(path)}`)).body?.files ?? []) as typeof files));
      const found = files.map((f) => ({ path: f.path, line: f.content.split('\n').find((l) => /spicy/i.test(l)) ?? '' })).find((f) => f.line !== '');
      const claims = await env.api('GET', '/v1/memory/claims');
      const claim = ((claims.body?.claims ?? claims.body?.items ?? []) as Array<{ id: string; text?: string; status?: string }>).find((c) => /spicy/i.test(c.text ?? ''));
      return [
        verdict('a memory file has the fact', found !== undefined, `files: ${files.map((f) => f.path).join(', ') || '(none)'}`),
        { name: 'where the fact was filed', ok: true, detail: found?.path ?? '(nowhere)' },
        verdict('the line carries a claim', /\[claim:[^\]]+\]/.test(found?.line ?? ''), `line: ${found?.line || '(none)'}`),
        verdict('a claim for it exists and is not retracted', claim !== undefined && claim.status !== 'retracted', `claims: ${JSON.stringify(claims.body).slice(0, 300)}`),
        verdict('the claim points at the line in that file', claim !== undefined && (claim as any).target?.path === found?.path, `claim target ${JSON.stringify((claim as any)?.target)}`),
      ];
    },
    (o) => {
      const reply = o.turns[1]?.replies.join('\n') ?? lastReply(o);
      const bad = spicyRecommendations(reply);
      return [verdict('the dinner recommendation is not spicy', reply.length > 0 && bad.length === 0, `spicy: ${bad.join(' | ')}`)];
    },
  ],
};
