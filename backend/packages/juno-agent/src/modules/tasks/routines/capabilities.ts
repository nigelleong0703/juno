/**
 * What a routine needs and whether its owner has it (BACKEND §3.6.1). A requirement is an any-of set, e.g. calendar =
 * {google-calendar, outlook}: one connected option is enough. Options are connector catalog ids, or `web_search` /
 * `computer` / `mac` for what the platform itself offers (`mac`: the owner's paired Mac is online and the agent may use it). Pure: the facts come in as arguments, nothing here reads a store.
 */
import type { AppProblem, Connection, RoutineMissing, RoutineRequirement } from '@agent-desktop/public-contracts';
import { routineRequirementSchema, PLATFORM_CAPABILITIES } from '@agent-desktop/public-contracts';

/**
 * What an agent (or, without one, its owner) can use right now: the apps that are connected and, for an agent, turned on for it,
 * by catalog id (value: the name the owner sees), and the platform's own tools.
 */
export interface OwnerCapabilities {
  connectors: ReadonlyMap<string, string>;
  webSearch: boolean;
  computer: boolean;
  mac: boolean;
  /** Why an app is not in `connectors`: not added, not turned on for this agent, or its sign-in expired (only with an agent). */
  problemOf?: (appId: string) => AppProblem | undefined;
}

/** Connected, enabled connector connections by catalog id. The Ideas starters use the same rule. */
export function connectedCatalog(connections: readonly Connection[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const connection of connections) {
    if (connection.catalogId !== undefined && connection.status === 'connected' && connection.enabled !== false) found.set(connection.catalogId, connection.name);
  }
  return found;
}


const isPlatform = (option: string): boolean => (PLATFORM_CAPABILITIES as readonly string[]).includes(option);
const ID = /^[a-z0-9][a-z0-9._-]*$/;

export function optionMet(option: string, have: OwnerCapabilities): boolean {
  if (option === 'web_search') return have.webSearch;
  if (option === 'computer') return have.computer;
  if (option === 'mac') return have.mac;
  return have.connectors.has(option);
}

/** The options a Connect button can act on: catalog ids, and `mac` (pair it / allow the agent). */
export const connectorOptions = (options: readonly string[]): string[] => options.filter((option) => option === 'mac' || !isPlatform(option));

/** "google-calendar" -> "Google Calendar", for an option the owner has not connected (so no connection name exists). */
export function humanize(id: string): string {
  if (id === 'web_search') return 'Web search';
  if (id === 'computer') return 'A computer';
  if (id === 'mac') return 'Your Mac';
  return id.split(/[-_.]/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** The requirements `have` does not meet, each with a human label ("Google Calendar or Outlook"). */
export function missingRequirements(requires: readonly RoutineRequirement[] | undefined, have: OwnerCapabilities): RoutineMissing[] {
  return (requires ?? []).filter((need) => !need.options.some((option) => optionMet(option, have))).map((need) => ({ ...need, label: need.options.map(humanize).join(' or ') }));
}

/** The names the owner sees for what satisfies `needs` now ("Google Calendar"), for the "now connected" note. */
export function satisfiedBy(needs: readonly RoutineRequirement[], have: OwnerCapabilities): string[] {
  const names = needs.flatMap((need) => need.options.filter((option) => optionMet(option, have)).map((option) => have.connectors.get(option) ?? humanize(option)));
  return [...new Set(names)];
}

export type RequiresParse = { ok: true; requires: RoutineRequirement[] } | { ok: false; error: string };

const EXAMPLE = 'Write each as a capability name with its options, e.g. {"calendar": ["google-calendar", "mac"]}, {"mail": ["gmail", "outlook", "mac"]}, "web_search", "computer" or a connector id such as "notion".';

/**
 * The model's loose `requires` (a list, or one object of capability -> options) as requirements. A bare string is a
 * capability with itself as the only option; an object with one key names the capability and its options.
 */
export function parseRequires(raw: unknown): RequiresParse {
  if (raw === undefined || raw === null) return { ok: true, requires: [] };
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.entries(raw).map(([capability, options]) => ({ [capability]: options })) : [raw];
  const requires: RoutineRequirement[] = [];
  for (const item of items) {
    const entry = loose(item);
    if (entry === undefined) return { ok: false, error: `requires: cannot read ${JSON.stringify(item)}. ${EXAMPLE}` };
    const options = [...new Set(entry.options.map((option) => option.trim().toLowerCase()))];
    const bad = options.find((option) => !ID.test(option));
    if (bad !== undefined || options.length === 0) return { ok: false, error: `requires: "${bad ?? ''}" is not a connector id or web_search / computer / mac. ${EXAMPLE}` };
    const parsed = routineRequirementSchema.safeParse({ capability: entry.capability.trim().toLowerCase(), options });
    if (!parsed.success) return { ok: false, error: `requires: ${parsed.error.issues[0]?.message ?? 'invalid'}. ${EXAMPLE}` };
    if (!requires.some((have) => have.capability === parsed.data.capability && have.options.join() === parsed.data.options.join())) requires.push(parsed.data);
  }
  return requires.length > 8 ? { ok: false, error: 'requires: at most 8 capabilities.' } : { ok: true, requires };
}

function loose(item: unknown): { capability: string; options: string[] } | undefined {
  if (typeof item === 'string') return item.trim() === '' ? undefined : { capability: item, options: [item] };
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const asList = (value: unknown): string[] | undefined => (typeof value === 'string' ? [value] : Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined);
  if (typeof record['capability'] === 'string') {
    const options = asList(record['options'] ?? record['anyOf'] ?? record['any_of']) ?? [record['capability']];
    return { capability: record['capability'], options };
  }
  const keys = Object.keys(record);
  const only = keys.length === 1 ? keys[0] : undefined;
  const options = only === undefined ? undefined : asList(record[only]);
  return only === undefined || options === undefined ? undefined : { capability: only, options };
}
