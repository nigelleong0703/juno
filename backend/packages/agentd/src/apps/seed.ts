/**
 * What the app catalog table starts from (BACKEND 10.18): the connectors the loaded plugins registered (the built-in `connectors-builtin`
 * among them) and the chat platforms the platform plugins registered, each as an app package at version 1. It runs at every boot but only adds
 * an app whose id the table does not have, so an app the admin edited, hid or retired is left alone, and a connector shipped in a later
 * release shows up. The web apps (Agent Reach channels that need no sign-in) are seeded the same way, with their how-to skill read from the
 * sandbox image's source files; after the first boot the skill text is the row's, changed through the admin API like any package.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePlatformSkillFile } from '@agent-desktop/memory-graph/skills';
import type { AppCatalogRow } from 'juno-agent/contracts';
import { CATALOG_OWNER, entryRow } from 'juno-agent/modules/apps/catalog';
import type { CatalogEntry } from 'juno-agent/modules/mcp/catalog';

/** Listing text of the chat platforms; their transport is the plugin of the same kind (code), only this text and the status are data. */
const CHAT_SEEDS: ReadonlyArray<{ id: string; name: string; blurb: string; description: string; tryAsking: string[] }> = [
  {
    id: 'slack', name: 'Slack', blurb: 'Your agents in Slack, each under its own @name.',
    description: 'Your agents answer in Slack channels and direct messages, each under its own @name.',
    tryAsking: ['@Nova summarise this thread', 'Remind the team about Friday\'s review'],
  },
  {
    id: 'discord', name: 'Discord', blurb: 'Your agents in Discord, each under its own @name.',
    description: 'Your agents answer in Discord servers and direct messages, each under its own @name.',
    tryAsking: ['@Nova what did we decide yesterday?', 'Plan Saturday\'s game night here'],
  },
  {
    id: 'telegram', name: 'Telegram', blurb: 'An agent with its own Telegram bot.',
    description: 'An agent with its own Telegram bot, in direct messages and groups.',
    tryAsking: ['What is on my calendar tomorrow?', 'Remind me to call mum at 6'],
  },
  {
    id: 'feishu', name: 'Feishu', blurb: 'An agent with its own Feishu or Lark bot.',
    description: 'An agent with its own Feishu or Lark bot, in direct messages and groups.',
    tryAsking: ['Summarise today\'s meeting', 'What did I miss in the team chat?'],
  },
];

/**
 * The Web & video apps: one per Agent Reach channel the agent reads through its computer. `reach` is the channel (also the name of its skill file,
 * `files/skills/_reach/<reach>.md` in the sandbox image's sources, which `_reach/common.md` completes). `login: 'sandbox'` marks a channel whose
 * reads need the person to sign in on the agent's own computer (request_takeover); without it the channel needs no sign-in. Adding one only
 * turns it on: the tool (`agent-reach`) is in the computer image, and what an agent does with it is in the skill.
 */
const WEB_SEEDS: ReadonlyArray<{ id: string; reach: string; login?: 'sandbox'; name: string; icon: string; blurb: string; description: string; tryAsking: string[] }> = [
  {
    id: 'youtube-videos', reach: 'youtube', name: 'YouTube videos', icon: 'video', blurb: 'Read a video\'s subtitles and details.',
    description: 'Your agents read a YouTube video\'s title, description and subtitles from their own computer, so they can summarise a video or find what was said in it. They only read: nothing is posted and no sign-in is needed.',
    tryAsking: ['Summarise this YouTube video for me', 'Find the part of this talk about pricing'],
  },
  {
    id: 'bilibili', reach: 'bilibili', name: 'Bilibili', icon: 'video', blurb: 'Search Bilibili and see what is trending.',
    description: 'Your agents search Bilibili, list what is trending and read a video\'s title, uploader and description from their own computer. Subtitles need a sign-in to Bilibili on the agent\'s computer. They only read.',
    tryAsking: ['What is trending on Bilibili today?', 'Search Bilibili for Rust async tutorials'],
  },
  {
    id: 'xiaohongshu', reach: 'xiaohongshu', login: 'sandbox', name: 'Xiaohongshu', icon: 'xiaohongshu', blurb: 'Read Xiaohongshu notes. Sign in on the agent\'s computer, ideally with a secondary account.',
    description: 'Your agents search Xiaohongshu (小红书), and read a note and its comments from their own computer. Reading needs you to sign in to Xiaohongshu once, on the agent\'s computer: you sign in yourself, and the session stays there. A secondary account is safer, because the platform may restrict automated reading. They only read: nothing is posted.',
    tryAsking: ['What are people on Xiaohongshu saying about coffee shops in Shanghai?', 'Summarise this Xiaohongshu note and its comments'],
  },
  {
    id: 'v2ex', reach: 'v2ex', name: 'V2EX', icon: 'doc', blurb: 'Read V2EX topics with their replies.',
    description: 'Your agents read V2EX: today\'s hot topics, the latest in a node, and a topic with its replies. They only read: nothing is posted and no sign-in is needed.',
    tryAsking: ['What is hot on V2EX right now?', 'Summarise this V2EX thread and what people replied'],
  },
  {
    id: 'github-reading', reach: 'github', name: 'GitHub (reading)', icon: 'issues', blurb: 'Read repositories, issues and pull requests.',
    description: 'Your agents read a public GitHub repository\'s README, and an issue or pull request with its comments, and search repositories. They only read: nothing is changed and no sign-in is needed.',
    tryAsking: ['Summarise this GitHub issue and the discussion', 'Is this pull request still open, and what is left to do?'],
  },
];

export type WebSeedRow = Omit<AppCatalogRow, 'createdAt' | 'updatedAt'>;

/**
 * The web app rows, with the skill each ships read from `<skillsDir>/_reach/`: the channel's file (front matter: the always-loaded description)
 * and the shared rules after it. A missing folder seeds none (they are added at a later boot that has it), a half-present one throws.
 */
export async function webSeedRows(skillsDir: string): Promise<WebSeedRow[]> {
  const dir = join(skillsDir, '_reach');
  const common = await readFile(join(dir, 'common.md'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (common === undefined) return [];
  const rows: WebSeedRow[] = [];
  for (const seed of WEB_SEEDS) {
    const file = parsePlatformSkillFile('agent-reach', await readFile(join(dir, seed.reach + '.md'), 'utf8'));
    if (file === null) throw new Error('the skill file of ' + seed.id + ' is empty');
    rows.push({
      id: seed.id + '@1', ownerId: CATALOG_OWNER, appId: seed.id, version: 1, category: 'web',
      interface: { displayName: seed.name, shortDescription: seed.blurb, longDescription: seed.description, icon: seed.icon, defaultPrompts: seed.tryAsking },
      mcpServers: {}, userConfig: {}, binding: { reach: seed.reach, login: seed.login ?? 'none' },
      skills: [{ name: 'agent-reach', description: file.description, instructions: file.instructions + '\n\n' + common.trim() }],
      onboardingSkill: 'agent-reach',
      status: 'listed',
    });
  }
  return rows;
}

/**
 * The rows to seed. Order is the page's order (each is a millisecond after the last): chat apps first, then the connectors as the plugins
 * listed them, then the web apps.
 */
export function seedRows(connectors: readonly CatalogEntry[], chatKinds: readonly string[], base: Date = new Date(), web: readonly WebSeedRow[] = []): AppCatalogRow[] {
  const at = (index: number): string => new Date(base.getTime() + index).toISOString();
  const chat = CHAT_SEEDS.filter((seed) => chatKinds.includes(seed.id)).map((seed, index): AppCatalogRow => ({
    id: seed.id + '@1', ownerId: CATALOG_OWNER, appId: seed.id, version: 1, category: 'chat',
    interface: { displayName: seed.name, shortDescription: seed.blurb, longDescription: seed.description, icon: seed.id, defaultPrompts: seed.tryAsking },
    mcpServers: {}, skills: [], userConfig: {}, binding: { plugin: seed.id },
    status: 'listed', createdAt: at(index), updatedAt: at(index),
  }));
  const work = connectors.map((entry, index) => entryRow(entry, at(chat.length + index)));
  const apps = web.map((row, index): AppCatalogRow => ({ ...row, createdAt: at(chat.length + work.length + index), updatedAt: at(chat.length + work.length + index) }));
  return [...chat, ...work, ...apps];
}
