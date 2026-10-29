/**
 * Discord rich messages: message components (an action row of buttons).
 *
 * `custom_id` is the `jn:` token (Discord allows 100 characters).
 */
import { chunkMarkdown, convertMarkdown, DISCORD_MARKDOWN, type ButtonStyle, type RichButton, type RichMessage } from '../render.js';

const BUTTON_STYLE: Record<ButtonStyle, number> = { primary: 1, default: 2, danger: 4 };
/** Characters per message, under Discord's 2000 to leave room for a reopened code fence. */
const SOURCE_CHUNK = 1900;

export type DiscordComponent = Record<string, unknown>;

/** Rows of at most five buttons. */
export function discordComponents(buttons: RichButton[]): DiscordComponent[] {
  const rows: DiscordComponent[] = [];
  for (let i = 0; i < Math.min(buttons.length, 25); i += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(i, i + 5).map((button) => ({ type: 2, style: BUTTON_STYLE[button.style], label: button.label.slice(0, 80), custom_id: button.id })),
    });
  }
  return rows;
}

/** The message bodies: converted text in pieces under the limit, the components on the last. */
export function discordMessages(rich: RichMessage): Array<{ content: string; components?: DiscordComponent[] }> {
  const chunks = chunkMarkdown(rich.text, SOURCE_CHUNK).map((chunk) => convertMarkdown(chunk, DISCORD_MARKDOWN));
  return chunks.map((content, index) => (index === chunks.length - 1 && rich.buttons.length > 0 ? { content, components: discordComponents(rich.buttons) } : { content }));
}

/** What the message shows after a tap: no buttons to press, one disabled button naming the choice. */
export function chosenComponents(label: string): DiscordComponent[] {
  return [{ type: 1, components: [{ type: 2, style: 2, label: ('✓ ' + label).slice(0, 80), custom_id: 'jn:x', disabled: true }] }];
}
