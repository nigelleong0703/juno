/**
 * Today's "inspiration" (BACKEND 10.10b): what else the app can do for the owner, in three layers: the daily ideas, starters
 * that use what the owner's profile says (city, company), and starters generated from what is enabled (connectors, computer,
 * web search, routines). Starters are a static table; nothing here calls a model.
 *
 * Rules: a dismissed item never returns, an item is returned for at most 3 days after it was first shown, at most 3 per
 * response (one of them may be an `unlock` card, always last), and a brand-new owner (no agents) only gets starters that lead to creating the first agent.
 */
import { type Hono } from 'hono';
import type { Inspiration, InspirationAction, UserState } from '@agent-desktop/public-contracts';
import type { Store } from '@agent-desktop/contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { readOwnerDevice } from 'juno-agent/execution/brain/context';
import { connectedCatalog } from 'juno-agent/modules/tasks/routines/capabilities';
import { docOwnerId, listAll } from './relationships.js';

export const INSPIRATION_MAX = 3;
export const INSPIRATION_SHOWN_DAYS = 3;
/** A user with this many sent messages is no longer in the cold start. */
export const STARTING_MESSAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The item scan that counts sent messages stops after this many pages: a cold-start owner has far fewer items. */
const MESSAGE_SCAN_PAGES = 5;

/** What the starters' conditions look at. */
export interface Facts {
  connectors: ReadonlySet<string>;
  computer: boolean;
  search: boolean;
  city?: string;
  company?: string;
  singapore: boolean;
  /** What the owner's enabled routines already do, read from their names and instructions. */
  routineKinds: ReadonlySet<RoutineKind>;
}

type RoutineKind = 'brief' | 'news' | 'email' | 'watch';
const ROUTINE_KIND_WORDS: Record<RoutineKind, RegExp> = {
  brief: /brief|简报|早报/i,
  news: /news|新闻/i,
  email: /e-?mail|inbox|邮件|收件/i,
  watch: /\bwatch|monitor|keep an eye|盯着|关注/i,
};

/** What a chat starter needs from an agent; matched against the agent's name, role line and description. */
type Skill = 'computer' | 'search' | 'mail' | 'calendar' | 'research' | 'shopping' | 'writing' | 'tasks';
const SKILL_WORDS: Record<Skill, readonly string[]> = {
  computer: ['computer', 'browser', 'desktop', 'automation', '电脑', '浏览器'],
  search: ['search', 'research', 'news', 'web', '搜索', '新闻', '研究'],
  mail: ['mail', 'inbox', '邮件', '收件'],
  calendar: ['calendar', 'schedule', 'meeting', 'planner', '日程', '日历', '会议'],
  research: ['research', 'analy', 'report', 'study', '研究', '分析'],
  shopping: ['shop', 'price', 'deal', 'buy', 'purchas', '购物', '比价'],
  writing: ['writ', 'draft', 'edit', 'copy', 'content', '写作', '文案'],
  tasks: ['task', 'project', 'issue', 'engineer', 'product', 'manager', '任务', '项目'],
};

interface Copy { title: string; prompt: string; reason?: string }
/** Text per locale; `{city}`, `{company}` come from the profile and `{agent}` is the chosen agent's name. Add a locale by adding a key. */
type Text = Record<string, Copy>;
const copy = (title: string, prompt: string, reason?: string): Copy => ({ title, prompt, ...(reason === undefined ? {} : { reason }) });

interface Starter {
  id: string;
  layer: 'profile' | 'capability';
  /** Offered to an owner with no agents yet: the action is a chat with no agent, which opens the new-agent form. */
  firstAgent?: boolean;
  /** The agent that gets the chat is the one whose text matches this best. */
  skill?: Skill;
  when: (facts: Facts) => boolean;
  text: Text;
}

/** A capability the owner has not turned on yet, shown as one card: `title` is the benefit, `prompt` the button label. */
interface Unlock {
  id: string;
  missing: (facts: Facts) => boolean;
  target: 'connector' | 'computer' | 'profile';
  connectorId?: string;
  /** Only `computer` unlocks name an agent. */
  skill?: Skill;
  text: Text;
}

const GMAIL = 'Gmail is connected';
const GMAIL_ZH = '已连接 Gmail';
const CAL = 'Google Calendar is connected';
const CAL_ZH = '已连接 Google 日历';
const SEARCH = '{agent} can search the web';
const SEARCH_ZH = '{agent} 可以上网搜索';
const COMPUTER = '{agent} has its own computer and browser';
const COMPUTER_ZH = '{agent} 有自己的电脑和浏览器';
const IN_CITY = 'Your profile says you are in {city}';
const IN_CITY_ZH = '你的资料里写着你在 {city}';
const IN_SG = 'Your profile says you are in Singapore';
const IN_SG_ZH = '你的资料里写着你在新加坡';
const AT_COMPANY = 'Your profile lists {company}';
const AT_COMPANY_ZH = '你的资料里有 {company}';

export const STARTERS: readonly Starter[] = [
  // --- first agent (owner has no agents) ---
  { id: 'first-assistant', layer: 'capability', firstAgent: true, when: () => true,
    text: { en: copy('Create your first assistant', 'Help me set up my first assistant. Ask what I would like to hand off, then set it up.', 'An assistant works on its own computer'),
      zh: copy('创建你的第一个助手', '帮我设置第一个助手。先问我想交给它做什么，再把它设置好。', '助手在自己的电脑上工作') } },
  { id: 'first-research', layer: 'capability', firstAgent: true, when: () => true,
    text: { en: copy('An assistant that researches anything', 'Research the best noise-cancelling headphones under $300 and summarise the trade-offs.'),
      zh: copy('什么都能查的助手', '帮我查一下 300 美元以内最好的降噪耳机，并总结各自的优缺点。') } },
  { id: 'first-inbox', layer: 'capability', firstAgent: true, when: (f) => f.connectors.has('gmail'),
    text: { en: copy('An assistant for your inbox', 'Look through my unread email and tell me what needs a reply today.', GMAIL),
      zh: copy('帮你管收件箱的助手', '看一下我的未读邮件，告诉我今天哪些需要回复。', GMAIL_ZH) } },
  { id: 'first-city', layer: 'profile', firstAgent: true, when: (f) => f.city !== undefined,
    text: { en: copy('An assistant who knows {city}', 'Find three things worth doing in {city} this weekend and plan one of them for me.', IN_CITY),
      zh: copy('熟悉 {city} 的助手', '帮我找三件这个周末在 {city} 值得做的事，并安排好其中一件。', IN_CITY_ZH) } },

  // --- profile ---
  { id: 'prof-city-weekend', layer: 'profile', skill: 'research', when: (f) => f.city !== undefined,
    text: { en: copy('Plan a weekend in {city}', 'Suggest a relaxed weekend plan in {city}: one place to eat, one thing to do outdoors, one indoor backup.', IN_CITY),
      zh: copy('规划一个 {city} 的周末', '在 {city} 为我安排一个轻松的周末：一个吃饭的地方、一项户外活动、一个室内备选。', IN_CITY_ZH) } },
  { id: 'prof-city-eat', layer: 'profile', skill: 'search', when: (f) => f.city !== undefined && (f.computer || f.search),
    text: { en: copy('Find a good place to eat in {city} tonight', 'Find three well-reviewed places to eat in {city} tonight that are open now, and tell me which you would pick.', IN_CITY),
      zh: copy('找找今晚 {city} 哪里好吃', '找三家今晚在 {city} 营业、评价不错的餐厅，并告诉我你会选哪家。', IN_CITY_ZH) } },
  { id: 'prof-city-news', layer: 'profile', skill: 'search', when: (f) => f.city !== undefined && f.search && !f.routineKinds.has('news'),
    text: { en: copy('Local news for {city}', 'Every morning at 7:30, find the news that matters in {city} (city life, transport, weather, local business) and post one short digest to my Feed.', IN_CITY),
      zh: copy('{city} 本地新闻', '每天早上 7:30，找出 {city} 值得看的新闻（城市生活、交通、天气、本地商业），整理成一篇简报发到我的动态。', IN_CITY_ZH) } },
  { id: 'prof-sg-commute', layer: 'profile', skill: 'search', when: (f) => f.singapore && f.search,
    text: { en: copy('Check my commute for MRT and bus disruptions', 'Check for MRT and bus disruptions in Singapore right now and tell me the best way to get across town.', IN_SG),
      zh: copy('看看地铁和公交有没有受影响', '查一下新加坡现在的地铁和公交有没有故障，并告诉我穿过市区最好的走法。', IN_SG_ZH) } },
  { id: 'prof-sg-prices', layer: 'profile', skill: 'shopping', when: (f) => f.singapore && f.computer,
    text: { en: copy('Compare prices on Shopee, Lazada and Amazon.sg', 'Compare the price of AirPods Pro on Shopee, Lazada and Amazon.sg and tell me the best deal including shipping.', IN_SG),
      zh: copy('比较 Shopee、Lazada 和 Amazon.sg 的价格', '比较 AirPods Pro 在 Shopee、Lazada 和 Amazon.sg 的价格，告诉我含运费最划算的是哪家。', IN_SG_ZH) } },
  { id: 'prof-company-news', layer: 'profile', skill: 'search', when: (f) => f.company !== undefined && f.search && !f.routineKinds.has('watch'),
    text: { en: copy('Watch the news about {company}', 'Every morning at 8:00, check for important news about {company} (announcements, funding, competitors, customers) and post it to my Feed only when something new happened.', AT_COMPANY),
      zh: copy('关注 {company} 的新闻', '每天早上 8:00 检查 {company} 的重要新闻（公告、融资、竞品、客户），只有出现新情况时才发到我的动态。', AT_COMPANY_ZH) } },
  { id: 'prof-company-research', layer: 'profile', skill: 'research', when: (f) => f.company !== undefined && f.search,
    text: { en: copy('Research the competitors of {company}', 'Research the main competitors of {company} and give me a short comparison of what each does differently.', AT_COMPANY),
      zh: copy('调研 {company} 的竞争对手', '调研 {company} 的主要竞争对手，简短对比各家有什么不同。', AT_COMPANY_ZH) } },

  // --- capabilities ---
  { id: 'cap-mail-digest', layer: 'capability', skill: 'mail', when: (f) => f.connectors.has('gmail'),
    text: { en: copy('Summarise today\'s important emails', 'Summarise the important emails I received today and tell me which need a reply.', GMAIL),
      zh: copy('总结今天的重要邮件', '总结我今天收到的重要邮件，并告诉我哪些需要回复。', GMAIL_ZH) } },
  { id: 'cap-mail-feed', layer: 'capability', skill: 'mail', when: (f) => f.connectors.has('gmail') && !f.routineKinds.has('email'),
    text: { en: copy('Get an email digest every morning', 'Every morning at 8:00, read my unread email and post a short digest to my Feed: the important messages, and which need a reply. Post nothing when nothing important arrived.', GMAIL),
      zh: copy('每天早上收一份邮件摘要', '每天早上 8:00 看一下我的未读邮件，把重要的邮件以及哪些需要回复整理成摘要发到我的动态；没有重要邮件就不发。', GMAIL_ZH) } },
  { id: 'cap-calendar-plan', layer: 'capability', skill: 'calendar', when: (f) => f.connectors.has('google-calendar'),
    text: { en: copy('Plan my day', 'Look at my calendar and plan my day: what to prepare and where I have free time.', CAL),
      zh: copy('帮我安排今天', '看看我的日历，安排我的一天：要准备什么、哪些时段有空。', CAL_ZH) } },
  { id: 'cap-calendar-prep', layer: 'capability', skill: 'calendar', when: (f) => f.connectors.has('google-calendar'),
    text: { en: copy('Prepare me for my next meeting', 'Find my next meeting and prepare me for it: who is there, what it is about, what I should bring.', CAL),
      zh: copy('帮我准备下一场会议', '找到我的下一场会议并帮我准备：谁参加、讨论什么、我该带什么。', CAL_ZH) } },
  { id: 'cap-drive-recent', layer: 'capability', skill: 'writing', when: (f) => f.connectors.has('google-drive'),
    text: { en: copy('Catch me up on files I changed this week', 'List the files I edited in Google Drive this week and summarise what changed.', 'Google Drive is connected'),
      zh: copy('回顾我这周改过的文件', '列出我这周在 Google Drive 里编辑过的文件，并总结改了什么。', '已连接 Google Drive') } },
  { id: 'cap-linear-issues', layer: 'capability', skill: 'tasks', when: (f) => f.connectors.has('linear'),
    text: { en: copy('Summarise the issues assigned to me', 'Summarise the open Linear issues assigned to me and tell me which to do first.', 'Linear is connected'),
      zh: copy('总结分配给我的任务', '总结分配给我的 Linear 未完成事项，并告诉我先做哪个。', '已连接 Linear') } },
  { id: 'cap-brief-feed', layer: 'capability', skill: 'calendar', when: (f) => !f.routineKinds.has('brief'),
    text: { en: copy('Start every morning with a brief', 'Every morning at 7:30, prepare a short brief of my day (what is on, what to prepare, anything due) and post it to my Feed.', 'Posts to your Feed at 7:30'),
      zh: copy('每天早上先看一份简报', '每天早上 7:30，准备一份简短的当日简报（有什么安排、要准备什么、哪些到期）发到我的动态。', '每天 7:30 发到你的动态') } },
  { id: 'cap-news-feed', layer: 'capability', skill: 'search', when: (f) => f.search && !f.routineKinds.has('news'),
    text: { en: copy('Every morning, send me Apple and AI news', 'Every morning at 7:30, find the top Apple and AI news and post one digest to my Feed.', SEARCH),
      zh: copy('每天早上发我苹果和 AI 新闻', '每天早上 7:30，找出苹果和 AI 方面的头条新闻，整理成一篇简报发到我的动态。', SEARCH_ZH) } },
  { id: 'cap-web-research', layer: 'capability', skill: 'research', when: (f) => f.search,
    text: { en: copy('Research something for me', 'Find the three best-reviewed standing desks under $500 and summarise the trade-offs.', SEARCH),
      zh: copy('帮我查点东西', '找出 500 美元以内评价最好的三款升降桌，并总结各自的取舍。', SEARCH_ZH) } },
  { id: 'cap-price-compare', layer: 'capability', skill: 'shopping', when: (f) => f.computer,
    text: { en: copy('Compare prices across three shops', 'Compare the price of AirPods Pro across three online shops and tell me the best deal including shipping.', COMPUTER),
      zh: copy('三家商店比比价', '比较 AirPods Pro 在三家网店的价格，告诉我含运费最划算的是哪家。', COMPUTER_ZH) } },
  { id: 'cap-browser-booking', layer: 'capability', skill: 'computer', when: (f) => f.computer,
    text: { en: copy('Find a flight for me', 'Find the cheapest return flight for a long weekend next month and show me three options.', COMPUTER),
      zh: copy('帮我找机票', '为下个月的一个小长假找最便宜的往返机票，给我三个选项。', COMPUTER_ZH) } },
  { id: 'cap-intro', layer: 'capability', when: () => true,
    text: { en: copy('What can you take off my plate?', 'What could you do for me? Suggest three things based on what you know about me.'),
      zh: copy('有什么可以交给你做？', '你能帮我做什么？根据你对我的了解，给我三个建议。') } },
];

/** What the owner has not turned on, in the order they are offered; at most one is shown. */
export const UNLOCKS: readonly Unlock[] = [
  { id: 'unlock-gmail', missing: (f) => !f.connectors.has('gmail'), target: 'connector', connectorId: 'gmail',
    text: { en: copy('Connect Gmail for a morning inbox digest', 'Connect Gmail', 'Your assistant can read and summarise your email'),
      zh: copy('连接 Gmail，每天早上收邮件摘要', '连接 Gmail', '助手可以阅读并总结你的邮件') } },
  { id: 'unlock-google-calendar', missing: (f) => !f.connectors.has('google-calendar'), target: 'connector', connectorId: 'google-calendar',
    text: { en: copy('Connect Google Calendar to plan your day', 'Connect Google Calendar', 'Your assistant can see your meetings'),
      zh: copy('连接 Google 日历，帮你安排每一天', '连接 Google 日历', '助手可以看到你的会议') } },
  { id: 'unlock-computer', missing: (f) => !f.computer, target: 'computer', skill: 'computer',
    text: { en: copy('Give {agent} a computer to compare prices and book trips', 'Set up a computer', 'A computer lets an assistant use a browser for you'),
      zh: copy('给 {agent} 一台电脑，帮你比价、订行程', '设置电脑', '有了电脑，助手可以替你操作浏览器') } },
  { id: 'unlock-profile', missing: (f) => f.city === undefined, target: 'profile',
    text: { en: copy('Add your city so suggestions fit where you are', 'Add your city', 'Your profile has no address yet'),
      zh: copy('填上你所在的城市，推荐会更贴近你', '填写城市', '你的资料里还没有地址') } },
];

/** An agent as far as assignment looks at it. */
export interface AgentInfo { id: string; name?: string; title?: string; description?: string; createdAt: string }

const fill = (text: string, facts: Facts, agentName?: string): string =>
  text.replace(/\{city\}/g, facts.city ?? '').replace(/\{company\}/g, facts.company ?? '').replace(/\{agent\}/g, agentName ?? 'Your assistant');
const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…');
const textFor = (text: Text, locale: string): Copy => text[locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'] ?? text['en']!;

/** Picks an agent per card: the best keyword match for the skill, ties to whoever has the fewest cards so far, then creation order. Nothing random, so a day's cards do not change on refresh. */
function agentPicker(agents: readonly AgentInfo[]): (skill: Skill | undefined) => AgentInfo | undefined {
  const ordered = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Map<string, number>();
  return (skill) => {
    if (ordered.length === 0) return undefined;
    const score = (agent: AgentInfo): number => {
      const haystack = `${agent.name ?? ''} ${agent.title ?? ''} ${agent.description ?? ''}`.toLowerCase();
      return skill === undefined ? 0 : SKILL_WORDS[skill].filter((word) => haystack.includes(word)).length;
    };
    const best = ordered.reduce((top, agent) => {
      const [s, t] = [score(agent), score(top)];
      return s > t || (s === t && (used.get(agent.id) ?? 0) < (used.get(top.id) ?? 0)) ? agent : top;
    });
    used.set(best.id, (used.get(best.id) ?? 0) + 1);
    return best;
  };
}

function toInspiration(starter: Starter, facts: Facts, locale: string, agent: AgentInfo | undefined, firstAgent: boolean): Inspiration {
  const text = textFor(starter.text, locale);
  const title = clip(fill(text.title, facts, agent?.name), 80);
  const prompt = clip(fill(text.prompt, facts, agent?.name), 300);
  const reason = text.reason === undefined ? undefined : clip(fill(text.reason, facts, agent?.name), 120);
  const agentId = firstAgent ? undefined : agent?.id;
  const action: InspirationAction = { type: 'chat', ...(agentId === undefined ? {} : { agentId }), text: prompt };
  return { id: starter.id, source: starter.layer, title, prompt, ...(agentId === undefined ? {} : { agentId }), ...(reason === undefined ? {} : { reason }), action };
}

function unlockInspiration(unlock: Unlock, facts: Facts, locale: string, agent: AgentInfo | undefined): Inspiration {
  const text = textFor(unlock.text, locale);
  const agentId = unlock.target === 'computer' ? agent?.id : undefined;
  return {
    id: unlock.id, source: 'unlock', title: clip(fill(text.title, facts, agent?.name), 80), prompt: clip(text.prompt, 300),
    ...(agentId === undefined ? {} : { agentId }),
    ...(text.reason === undefined ? {} : { reason: clip(text.reason, 120) }),
    action: { type: 'unlock', target: unlock.target, ...(unlock.connectorId === undefined ? {} : { connectorId: unlock.connectorId }), ...(agentId === undefined ? {} : { agentId }) },
  };
}

/** What the owner's profile says about where they are and where they work (entries are free text: the last line of an address is its city or country). */
function profileFacts(profile: { entries?: Array<{ key: string; value: string }> } | null): Pick<Facts, 'city' | 'company' | 'singapore'> {
  const entries = profile?.entries ?? [];
  const byKey = (pattern: RegExp) => entries.find((entry) => pattern.test(entry.key.trim()))?.value;
  const company = byKey(/^(company|employer|organi[sz]ation|workplace)$/i);
  const address = byKey(/^(city|location)$/i) ?? byKey(/^home address$/i) ?? entries.find((entry) => /address/i.test(entry.key))?.value;
  const last = address?.split(/[\n,]/).map((part) => part.replace(/\d+/g, '').replace(/[#-]+/g, ' ').trim()).filter((part) => part.length > 0).at(-1);
  return {
    ...(last === undefined ? {} : { city: last }),
    ...(company === undefined ? {} : { company }),
    singapore: address !== undefined && /singapore/i.test(address),
  };
}

/** How far along the owner is: no agents, fewer than 10 sent messages, or past that. */
export async function userStateOf(store: Store, ownerId: string, agentCount: number): Promise<UserState> {
  if (agentCount === 0) return 'new';
  let sent = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MESSAGE_SCAN_PAGES; page += 1) {
    const listed = await store.list('items', cursor === undefined ? { limit: 200 } : { limit: 200, cursor });
    for (const item of listed.items) {
      if (item.type === 'user_message' && item.authorId === ownerId) sent += 1;
    }
    if (sent >= STARTING_MESSAGES) return 'regular';
    cursor = listed.nextCursor;
    if (cursor === undefined) break;
  }
  return 'starting';
}

export const inspirationRowId = (ownerId: string, id: string): string => `${ownerId}:${id}`;

/** The inspirations to show, in order; records the first time each is shown. */
export async function composeInspiration(deps: AgentdDeps, ownerId: string, userState: UserState, now: Date, agents: readonly AgentInfo[]): Promise<Inspiration[]> {
  const { store } = deps;
  const own = async <T extends { id: string }>(rows: Promise<{ items: T[] }>): Promise<T[]> => (await rows).items.filter((row) => docOwnerId(row) === ownerId);
  const [connections, routines, profile, ideas, rows, device] = await Promise.all([
    own(listAll(store, 'connections')),
    own(listAll(store, 'routines')),
    store.get('profiles', `profile-${ownerId}`),
    userState === 'new' ? Promise.resolve([]) : own(listAll(store, 'ideas')),
    own(listAll(store, 'inspirations')),
    readOwnerDevice(store, ownerId),
  ]);
  const locale = device.locale ?? 'en';
  const facts: Facts = {
    connectors: new Set(connectedCatalog(connections).keys()),
    computer: deps.computerd !== undefined,
    search: String(deps.config?.['SEARCH_PROVIDER'] ?? '') !== '',
    routineKinds: new Set((Object.keys(ROUTINE_KIND_WORDS) as RoutineKind[]).filter((kind) => routines.some((r) => r.enabled && ROUTINE_KIND_WORDS[kind].test(`${r.name} ${r.instructions}`)))),
    ...profileFacts(profile),
  };
  const state = new Map(rows.map((row) => [row.inspirationId, row]));
  const live = (id: string): boolean => {
    const row = state.get(id);
    if (row === undefined) return true;
    return row.dismissedAt === undefined && now.getTime() - Date.parse(row.firstShownAt) <= INSPIRATION_SHOWN_DAYS * DAY_MS;
  };
  const pickAgent = agentPicker(agents);

  const fromIdeas: Inspiration[] = ideas
    .filter((idea) => idea.status === 'open' && live(idea.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map((idea) => {
      const action = idea.action ?? { agentId: idea.agentId, prompt: idea.prompt };
      return {
        id: idea.id, source: 'idea' as const, title: clip(idea.text, 80), prompt: clip(action.prompt, 300), agentId: action.agentId,
        ...(idea.why === undefined ? {} : { reason: clip(idea.why, 120) }),
        action: { type: 'chat' as const, agentId: action.agentId, text: clip(action.prompt, 300) },
      };
    });
  const firstAgent = userState === 'new';
  const eligible = STARTERS.filter((s) => (firstAgent ? s.firstAgent === true : s.firstAgent !== true) && s.when(facts) && live(s.id));
  const unlock = firstAgent ? undefined : UNLOCKS.find((u) => u.missing(facts) && live(u.id));
  const room = Math.max(0, (unlock === undefined ? INSPIRATION_MAX : INSPIRATION_MAX - 1) - fromIdeas.length);
  const chosen = [...eligible.filter((s) => s.layer === 'profile'), ...eligible.filter((s) => s.layer === 'capability')].slice(0, room);
  const picked = [...fromIdeas.slice(0, unlock === undefined ? INSPIRATION_MAX : INSPIRATION_MAX - 1),
    ...chosen.map((s) => toInspiration(s, facts, locale, firstAgent ? undefined : pickAgent(s.skill), firstAgent))];
  if (unlock !== undefined) picked.push(unlockInspiration(unlock, facts, locale, pickAgent(unlock.skill)));

  const stamp = now.toISOString();
  await Promise.all(picked.filter((item) => !state.has(item.id)).map((item) =>
    store.put('inspirations', { id: inspirationRowId(ownerId, item.id), inspirationId: item.id, firstShownAt: stamp, updatedAt: stamp, ownerId } as never)));
  return picked;
}

export function registerInspiration(app: Hono, deps: AgentdDeps) {
  /** Dismiss a starter or an idea: it never returns. For an idea the idea itself is dismissed too, which also feeds the ideas job's 14-day cooldown. */
  app.post('/v1/inspiration/:id/dismiss', async (c) => {
    const ownerId = getOwnerId(c);
    const id = c.req.param('id');
    const now = new Date().toISOString();
    const idea = await deps.store.get('ideas', id);
    if (idea !== null && docOwnerId(idea) === ownerId && idea.status !== 'dismissed') {
      const updated = await deps.store.patch('ideas', id, { status: 'dismissed', updatedAt: now });
      await deps.store.emit({ type: 'idea.updated', idea: updated });
    }
    const rowId = inspirationRowId(ownerId, id);
    const existing = await deps.store.get('inspirations', rowId);
    if (existing === null) await deps.store.put('inspirations', { id: rowId, inspirationId: id, firstShownAt: now, dismissedAt: now, updatedAt: now, ownerId } as never);
    else if (existing.dismissedAt === undefined) await deps.store.patch('inspirations', rowId, { dismissedAt: now, updatedAt: now });
    return c.json({ id, dismissed: true });
  });
}
