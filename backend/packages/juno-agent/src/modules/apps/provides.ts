// What a catalog app lets an agent do, as a closed vocabulary of capability tags (BACKEND 10.18.1), and the ranking that turns "the person needs
// to send email" into the apps of OUR catalog that could do it, best first. Nothing outside the catalog is ever recommended.
import type { CatalogEntry } from '../mcp/catalog.js';

/** Tag -> the words the person and the model use for it. The only place the vocabulary is written; the admin schema accepts only these. */
export const CAPABILITIES = {
  'mail.read': 'read email',
  'mail.draft': 'write email drafts',
  'mail.send': 'send email',
  'calendar.read': 'read the calendar',
  'calendar.write': 'add or change calendar events',
  'docs.read': 'read documents',
  'docs.write': 'edit documents',
  'sheets.read': 'read spreadsheets',
  'sheets.write': 'edit spreadsheets',
  'files.read': 'find and read files',
  'files.write': 'create, save or copy files',
  'contacts.read': 'look up contacts',
  'contacts.write': 'add contacts',
  'tasks.read': 'see to-dos',
  'tasks.write': 'add or complete to-dos',
  'notes.read': 'read notes and pages',
  'notes.write': 'write notes and pages',
  'projects.read': 'look up issues and projects',
  'projects.write': 'create or update issues and projects',
  'chat.read': 'read team chat',
  'payments.read': 'look up payments and customers',
  'payments.write': 'create invoices, refunds and other changes in the payment account',
  'maps.read': 'find places and travel times',
  'transport.read': 'check public transport',
  'video.search': 'search videos and music',
  'video.library': 'see playlists and subscriptions',
  'fitness.read': 'see workouts and training',
  'fitness.write': 'log workouts',
  'automation.run': 'run actions in linked apps',
  'crm.read': 'look up customers and deals in the CRM',
  'music.read': 'see playlists and listening history',
  'music.write': 'play music and edit playlists',
  'shop.read': 'look up products and orders in an online store',
  'shop.write': 'change products, inventory and orders in an online store',
} as const;

export type CapabilityTag = keyof typeof CAPABILITIES;
export const CAPABILITY_TAGS = Object.keys(CAPABILITIES) as CapabilityTag[];

/** The tags a need names: an exact tag, or a family (`mail` = every `mail.*`); undefined when it is neither. */
export function tagsOfNeed(need: string): CapabilityTag[] | undefined {
  const wanted = need.trim().toLowerCase();
  const matched = CAPABILITY_TAGS.filter((tag) => tag === wanted || tag.startsWith(wanted + '.'));
  return matched.length === 0 ? undefined : matched;
}

/** "send email" for `mail.send`; a family reads as its tags' words joined. */
export const phraseOfNeed = (tags: readonly CapabilityTag[]): string => tags.map((tag) => CAPABILITIES[tag]).join(' or ');

export type Standing = 'ready' | 'fix' | 'add' | 'unavailable';

export interface Candidate {
  id: string;
  name: string;
  /** `ready`: the agent can use it now. `fix`: added but off for the agent or needs a new sign-in. `add`: not added. `unavailable`: this deployment cannot offer it. */
  standing: Standing;
  /** How many of the needed tags it provides. */
  matches: number;
  /** The owner already uses another app of the same account provider (Google, Microsoft), so one sign-in covers it. */
  sameAccount: boolean;
}

const RANK: Record<Standing, number> = { ready: 0, fix: 1, add: 2, unavailable: 3 };

/**
 * The catalog apps that provide any of `tags`, best first: what the agent can already use, then what only needs turning on or signing in again,
 * then what is not added (an app on an account provider the owner already signed in to first, then the one that covers more of the need, then
 * the catalog's own order), and last what this deployment cannot offer.
 */
export function rankForNeed(
  catalog: readonly CatalogEntry[],
  tags: readonly CapabilityTag[],
  standingOf: (entry: CatalogEntry) => Standing,
  usedIssuers: ReadonlySet<string>,
): Candidate[] {
  return catalog
    .map((entry, order) => ({ entry, order, matches: tags.filter((tag) => (entry.provides ?? []).includes(tag)).length }))
    .filter(({ matches }) => matches > 0)
    .map(({ entry, order, matches }) => ({ order, candidate: { id: entry.id, name: entry.name, standing: standingOf(entry), matches, sameAccount: entry.configuredClientIssuer !== undefined && usedIssuers.has(entry.configuredClientIssuer) } }))
    .sort((a, b) => RANK[a.candidate.standing] - RANK[b.candidate.standing] || Number(b.candidate.sameAccount) - Number(a.candidate.sameAccount) || b.candidate.matches - a.candidate.matches || a.order - b.order)
    .map(({ candidate }) => candidate);
}
