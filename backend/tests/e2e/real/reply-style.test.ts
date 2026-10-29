import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Reply style with a real model (BACKEND.md, "Reply style"): a final reply arrives as short bubbles,
 * plain sentences in chat, and a card only for structured content. Checks shape, never wording:
 * bubble count and length, no markdown headings/bold/list lines in chat bubbles, card or no card.
 */
interface Bubble { markdown: string; ui?: unknown }

const LIST_LINE = /^\s*([-*•]|\d+[.)])\s/m;
const HEADING = /^#{1,6}\s/m;

describe('real model: reply style', () => {
  it('greets briefly, answers a fact in one bubble, compares with a card, and chats without structure', async () => {
    const account = await createAccount('real-reply-style');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Tavi' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      // waitFor also matches events already received, so every finished run is remembered and skipped.
      const seenRuns = new Set<string>();

      /** Send one message, wait for its run, return that run's agent bubbles in order. */
      const ask = async (text: string): Promise<Bubble[]> => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        return nextRun(text);
      };
      /** Wait for the next top-level run in the conversation (a reply, or the follow-up a child's result wakes). */
      const nextRun = async (text: string, timeoutMs = 240_000): Promise<Bubble[]> => {
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
          timeoutMs,
        );
        const runId: string = finished.data.metadata.juno.run.id;
        seenRuns.add(runId);
        expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
        const bubbles: Bubble[] = (items.body.items as Array<{ type: string; runId?: string; markdown?: string; ui?: unknown }>)
          .filter((item) => item.type === 'agent_message' && item.runId === runId)
          .map((item) => ({ markdown: item.markdown ?? '', ...(item.ui === undefined ? {} : { ui: item.ui }) }));
        expect(bubbles.length, `no reply for: ${text}`).toBeGreaterThan(0);
        return bubbles;
      };
      const show = (bubbles: Bubble[]): string => JSON.stringify(bubbles.map((b) => (b.ui ? `[card] ${b.markdown}` : b.markdown)));
      const prose = (bubbles: Bubble[]): string => bubbles.filter((b) => b.ui === undefined).map((b) => b.markdown).join('\n\n');
      const plainChat = (bubbles: Bubble[]): void => {
        const text = prose(bubbles);
        expect(text, show(bubbles)).not.toMatch(/\*\*/);
        expect(text, show(bubbles)).not.toMatch(HEADING);
        expect(text, show(bubbles)).not.toMatch(LIST_LINE);
      };

      const greeting = await ask('hi! who are you?');
      plainChat(greeting);
      expect(greeting.some((b) => b.ui !== undefined), show(greeting)).toBe(false);
      expect(prose(greeting).length, show(greeting)).toBeLessThanOrEqual(200);

      const fact = await ask("what's the capital of australia");
      expect(fact.length, show(fact)).toBe(1);
      expect(fact[0]?.ui, show(fact)).toBeUndefined();
      expect(fact[0]?.markdown.length ?? 0, show(fact)).toBeLessThanOrEqual(120);
      expect(fact[0]?.markdown ?? '', show(fact)).toMatch(/canberra/i);

      const compare = await ask('Compare the iPhone 16 and the Pixel 9 on price, battery and camera. Just from what you know, do not search.');
      plainChat(compare);
      expect(compare.some((b) => b.ui !== undefined), show(compare)).toBe(true);
      expect(compare.length, show(compare)).toBeLessThanOrEqual(4);

      const feeling = await ask("I'm a bit stressed about work today");
      plainChat(feeling);
      expect(feeling.some((b) => b.ui !== undefined), show(feeling)).toBe(false);
      expect(feeling.length, show(feeling)).toBeLessThanOrEqual(3);

      // Asked directly what it can do: concrete abilities, not a deflection back to the user (2026-10-21 Telegram).
      const abilities = await ask('what tool do u have');
      plainChat(abilities);
      expect(prose(abilities), show(abilities)).not.toMatch(/tool list|just tell me what/i);
      expect(abilities.length, show(abilities)).toBeLessThanOrEqual(3);

      // A researched plan answer: the takeaway in a few short bubbles, then an offer to follow through
      // (2026-10-21: five dense bubbles of forecast data, no offer).
      const tripAsk = 'Check the weather in Kuala Lumpur for this Friday night to Monday afternoon and tell me how it affects our plan for 2 adults staying in KLCC, with what to pack and wear.';
      let trip = await ask(tripAsk);
      // The agent may hand the lookup to a background child and answer when its result wakes it.
      // When it answered directly there is no follow-up run, so the wait just times out and the first reply stands.
      if (!trip.some((b) => b.ui !== undefined)) trip = await nextRun(tripAsk, 150_000).catch(() => trip);
      const tripText = prose(trip);
      plainChat(trip);
      expect(trip.length, show(trip)).toBeLessThanOrEqual(5);
      expect(tripText.split(/\s+/).length, show(trip)).toBeLessThanOrEqual(130);
      expect(trip.some((b) => b.ui !== undefined), show(trip)).toBe(true);

      const words = (bubbles: Bubble[]) => prose(bubbles).split(/\s+/).filter(Boolean).length;
      // eslint-disable-next-line no-console
      console.log('reply-style metrics', Object.fromEntries(Object.entries({ greeting, fact, compare, feeling, abilities, trip })
        .map(([key, bubbles]) => [key, { bubbles: bubbles.length, words: words(bubbles), dashes: (prose(bubbles).match(/—/g) ?? []).length, card: bubbles.some((b) => b.ui !== undefined) }])));
      // eslint-disable-next-line no-console
      console.log('reply-style transcript', { greeting: show(greeting), fact: show(fact), compare: show(compare), feeling: show(feeling), abilities: show(abilities), trip: show(trip) });
    } finally {
      events.close();
    }
  }, 900_000);
});
