/**
 * Slack rich messages: Block Kit (mrkdwn sections, one actions block of buttons).
 *
 * Slack caps a section's text at 3000 characters and a message at 50 blocks, so long text is cut into sections and, past
 * 45 blocks, into several messages with the buttons on the last.
 */
import { chunkMarkdown, convertMarkdown, SLACK_MRKDWN, type RichButton, type RichMessage } from '../render.js';

const SECTION_LIMIT = 2900;
const BLOCKS_PER_MESSAGE = 45;

export type SlackBlock = Record<string, unknown>;

export function slackButtonBlock(buttons: RichButton[]): SlackBlock {
  return {
    type: 'actions',
    block_id: 'jn_actions',
    elements: buttons.slice(0, 25).map((button) => ({
      type: 'button',
      text: { type: 'plain_text', text: button.label.slice(0, 75), emoji: true },
      action_id: button.id,
      value: button.id,
      ...(button.style === 'default' ? {} : { style: button.style }),
    })),
  };
}

/** The text as mrkdwn sections of at most 2900 characters. */
export function slackSections(markdown: string): SlackBlock[] {
  return chunkMarkdown(markdown, SECTION_LIMIT).map((chunk) => ({ type: 'section', text: { type: 'mrkdwn', text: convertMarkdown(chunk, SLACK_MRKDWN) } }));
}

/** One or more `chat.postMessage` bodies (without channel / thread): `text` is the notification fallback. */
export function slackMessages(rich: RichMessage): Array<{ text: string; blocks: SlackBlock[] }> {
  const sections = slackSections(rich.text);
  const groups: SlackBlock[][] = [];
  for (let i = 0; i < sections.length; i += BLOCKS_PER_MESSAGE) groups.push(sections.slice(i, i + BLOCKS_PER_MESSAGE));
  const last = groups[groups.length - 1] ?? [];
  if (groups.length === 0) groups.push(last);
  if (rich.buttons.length > 0) last.push(slackButtonBlock(rich.buttons));
  return groups.map((blocks, index) => ({ text: convertMarkdown(index === 0 ? rich.text : '…', SLACK_MRKDWN).slice(0, 3000), blocks }));
}

/** The original blocks with the buttons replaced by a line naming the choice. */
export function chosenBlocks(blocks: SlackBlock[], label: string): SlackBlock[] {
  return [...blocks.filter((block) => block['type'] !== 'actions'), { type: 'context', elements: [{ type: 'mrkdwn', text: '✓ ' + convertMarkdown(label, SLACK_MRKDWN) }] }];
}
