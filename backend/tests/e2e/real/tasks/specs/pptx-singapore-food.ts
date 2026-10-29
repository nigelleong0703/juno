import { callsOf, okResultsOf, skillsUsed } from '../observe';
import { fail, pass, verdict, type CheckEnv, type CheckResult, type Observed, type TaskSpec } from '../types';
import { pptxSlides } from '../zip';
import { commonChecks, takeoverChecks } from './common';

/** The deliverable cards of a conversation: artifact id + version, newest last. */
export async function artifactCards(o: Observed, env: CheckEnv): Promise<Array<{ artifactId: string; version: number }>> {
  const cards: Array<{ artifactId: string; version: number }> = [];
  for (const turn of o.turns) {
    const items = await env.api('GET', `/v1/conversations/${turn.conversationId}/items?limit=200`);
    for (const item of (items.body?.items ?? []) as Array<Record<string, any>>) {
      if (item.type === 'artifact' && typeof item.artifactId === 'string') cards.push({ artifactId: item.artifactId, version: Number(item.version ?? 1) });
    }
  }
  return cards;
}

export async function pptxChecks(o: Observed, env: CheckEnv): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const cards = await artifactCards(o, env);
  const pptx: Array<{ artifactId: string; version: number; name: string; data: Buffer }> = [];
  for (const card of cards) {
    const file = await env.api('GET', `/v1/artifacts/${card.artifactId}/versions/${card.version}/download`);
    if (file.status === 200 && /\.pptx$/i.test(String(file.body?.name))) pptx.push({ ...card, name: String(file.body.name), data: Buffer.from(String(file.body.contentBase64), 'base64') });
  }
  out.push(verdict('a .pptx artifact was published', pptx.length > 0, `artifact cards ${cards.length}, none is a .pptx`));
  const deck = pptx.at(-1);
  if (deck === undefined) return out;
  try {
    const slides = pptxSlides(deck.data);
    out.push(verdict('the deck has 5 slides', slides.length === 5, `${slides.length} slides`));
    const untitled = slides.filter((s) => (s.texts[0] ?? '').length === 0).map((s) => s.name);
    out.push(verdict('every slide has a title', untitled.length === 0, `no text on ${untitled.join(', ')}`));
    const titles = slides.map((s) => s.texts[0] ?? '');
    out.push(verdict('slide titles are different', new Set(titles).size === titles.length, titles.join(' | ')));
    out.push(pass('titles', titles.join(' | ')));
    out.push(verdict('the deck is about Singapore food', /singapore|chicken rice|laksa|satay|hawker|chilli crab|kaya/i.test(slides.flatMap((s) => s.texts).join(' ')), 'no food words in the slides'));
  } catch (error) {
    out.push(fail('the deck opens', String(error)));
  }
  const preview = await env.api('GET', `/v1/artifacts/${deck.artifactId}/versions/${deck.version}/download?part=preview`);
  out.push(verdict('a preview was stored with the deck', preview.status === 200, `preview download ${preview.status}`));
  return out;
}

export const pptxSingaporeFood: TaskSpec = {
  id: 'pptx-singapore-food',
  title: '5-slide PPT about Singapore food, delivered',
  timeoutMs: 900_000,
  turns: [{ message: 'Make a 5-slide PPT about Singapore food and send it to me.' }],
  user: { fallbackReply: 'use your best judgement', defaultApproval: 'approve', replies: [{ match: /./, answer: 'use your best judgement' }] },
  checks: [
    (o) => commonChecks(o),
    (o) => [
      verdict('the pptx skill was used', skillsUsed(o).includes('pptx'), `skills seen: ${skillsUsed(o).join(', ') || 'none'}`),
      verdict('artifact_publish was called and succeeded', okResultsOf(o, 'artifact_publish').length > 0 && callsOf(o, 'artifact_publish').length > 0, 'artifact_publish missing or failed'),
    ],
    pptxChecks,
    (o) => takeoverChecks(o),
  ],
};
