/**
 * A tap on a platform button, platform-neutral. Each platform parses its own payload into a `ParsedClick` (`inbound.parseClick` of
 * its adapter) that already knows how to answer the tap on that platform (`ack`); agentd decides what the tap means (interactions.ts)
 * and passes the outcome back. The token names a stored item or request (render.ts), never anything from the platform payload.
 */
import type { RichMessage } from './render.js';

export type ClickOutcome =
  | { status: 'done'; label: string }
  | { status: 'not-owner' }
  | { status: 'stale'; reason: string }
  /** A button that does nothing (Discord's disabled "chosen" button): the platform is only told the tap arrived. */
  | { status: 'inert' };

export const NOT_OWNER_TEXT = 'Only the owner can decide this.';
export const STALE_TEXT = 'This choice is no longer available.';

/** What answering a tap needs: the injected `fetch`, the bot token of the channel (absent when the platform answers without one), and, for a platform that redraws the card on a tap, the message rebuilt from the store. */
export interface ClickEnv {
  fetchFn: typeof fetch;
  token: string | undefined;
  redraw?: RichMessage;
}

export interface ParsedClick {
  /** The `jn:` token on the pressed button. */
  token: string;
  from: { id: string; name: string };
  /** A button that must not reach the store (answered as received). */
  inert?: boolean;
  /** Answers the tap on the platform (clears the spinner, shows a note, replaces the buttons by the choice). A platform that answers in its HTTP response (Feishu) returns the response body. */
  ack(env: ClickEnv, outcome: ClickOutcome): Promise<Record<string, unknown> | undefined>;
  /** The platform redraws the whole message from the rich message on a successful tap (Feishu's card). */
  redraws?: boolean;
}
