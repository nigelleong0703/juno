import type { NamespaceGroup } from './namespaceDirectory.js';

/** A deterministic, user-named MCP scope. An absent scope means the broad catalog fallback. */
export interface DiscoveryScope {
  groups: NamespaceGroup[];
}

interface Alias {
  group: NamespaceGroup;
  identity: string;
  kind: 'app' | 'account' | 'email';
}

interface AliasName { value: string; kind: 'app' | 'account' | 'email' }

const GENERIC_ALIAS_WORDS = new Set([
  'app', 'connected', 'connection', 'mcp', 'tool', 'tools', 'server', 'service',
  'google', 'outlook', 'microsoft',
]);

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[_\-.@/+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function identityOf(group: NamespaceGroup): string {
  const origin = group.tools.find((tool) => tool.origin !== undefined)?.origin;
  if (origin?.catalogId !== undefined && origin.catalogId.trim() !== '') return normalized(origin.catalogId);
  return normalized(group.connectionName ?? group.namespace);
}

function aliasesOf(group: NamespaceGroup): AliasName[] {
  const values = new Map<string, AliasName>();
  const rank = (kind: AliasName['kind']): number => kind === 'app' ? 3 : kind === 'email' ? 2 : 1;
  const add = (value: string | undefined, kind: AliasName['kind'] = 'app', expandWords = true): void => {
    if (value === undefined) return;
    const key = normalized(value);
    if (key.replace(/\s+/g, '').length < 3) return;
    const current = values.get(key);
    if (current === undefined || rank(kind) > rank(current.kind)) values.set(key, { value: key, kind });
    if (expandWords) for (const word of key.split(' ')) {
      if (word.length >= 4 && !GENERIC_ALIAS_WORDS.has(word)) {
        const prior = values.get(word);
        if (prior === undefined || rank(kind) > rank(prior.kind)) values.set(word, { value: word, kind });
      }
    }
  };

  add(group.connectionName);
  add(group.account, group.account?.includes('@') === true ? 'email' : 'account', false);
  add(group.namespace.replace(/^mcp__/, '').replace(/__\*$/, ''), 'app', false);
  for (const tool of group.tools) {
    const origin = tool.origin;
    if (origin === undefined) continue;
    add(origin.catalogId);
    add(origin.connectionName);
    add(origin.account, origin.account?.includes('@') === true ? 'email' : 'account', false);
    const at = origin.account?.indexOf('@') ?? -1;
    if (at > 0) add(origin.account?.slice(0, at), 'account', false);
  }
  return [...values.values()];
}

function containsAlias(query: string, alias: string): boolean {
  let from = 0;
  for (;;) {
    const index = query.indexOf(alias, from);
    if (index < 0) return false;
    const before = index === 0 ? '' : query[index - 1] ?? '';
    const after = query[index + alias.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = index + 1;
  }
}

/**
 * Narrow only on an available MCP namespace, connection label, catalog id, full email, or an
 * account label refining a named app. Several named apps/accounts are valid. A short connector
 * word shared by different apps is ambiguous and keeps broad coverage.
 */
export function selectDiscoveryScope(groups: readonly NamespaceGroup[], query: string): DiscoveryScope | undefined {
  const request = normalized(query);
  if (request === '') return undefined;

  const matched = new Map<string, Alias[]>();
  for (const group of groups) {
    if (!group.key.startsWith('mcp:')) continue;
    const identity = identityOf(group);
    for (const { value, kind } of aliasesOf(group)) {
      if (!containsAlias(request, value)) continue;
      const entries = matched.get(value) ?? [];
      entries.push({ group, identity, kind });
      matched.set(value, entries);
    }
  }
  if (matched.size === 0) return undefined;

  const standaloneIdentities = new Set<string>();
  let hasShortAccountAlias = false;
  for (const entries of matched.values()) {
    for (const entry of entries) {
      if (entry.kind === 'app' || entry.kind === 'email') standaloneIdentities.add(entry.identity);
      if (entry.kind === 'account') hasShortAccountAlias = true;
    }
  }
  if (standaloneIdentities.size === 0 && hasShortAccountAlias) return undefined;

  // "Google Calendar" also contains the generic word "calendar". A longer alias the user
  // actually supplied dominates that shorter fragment instead of making the request ambiguous.
  for (const alias of [...matched.keys()]) {
    const coveredByLonger = [...matched.keys()].some((other) => other !== alias && containsAlias(other, alias));
    if (coveredByLonger) matched.delete(alias);
  }
  if (matched.size === 0) return undefined;

  const appIdentities = new Set<string>();
  const emailIdentities = new Set<string>();
  for (const entries of matched.values()) {
    for (const entry of entries) {
      if (entry.kind === 'app') appIdentities.add(entry.identity);
      if (entry.kind === 'email') emailIdentities.add(entry.identity);
    }
  }
  const allowedIdentities = appIdentities.size > 0 ? appIdentities : emailIdentities;

  const uniquelyNamed = new Set<string>();
  for (const entries of matched.values()) {
    const identities = new Set(entries.map((entry) => entry.identity).filter((identity) => allowedIdentities.has(identity)));
    if (identities.size === 1) for (const identity of identities) uniquelyNamed.add(identity);
  }
  for (const entries of matched.values()) {
    const identities = new Set(entries.map((entry) => entry.identity).filter((identity) => allowedIdentities.has(identity)));
    if (identities.size <= 1) continue;
    if ([...identities].some((identity) => !uniquelyNamed.has(identity))) return undefined;
  }

  const byIdentity = new Map<string, Alias[]>();
  for (const entries of matched.values()) {
    for (const entry of entries) {
      if (!allowedIdentities.has(entry.identity)) continue;
      const all = byIdentity.get(entry.identity) ?? [];
      all.push(entry);
      byIdentity.set(entry.identity, all);
    }
  }

  const selectedGroups = new Map<string, NamespaceGroup>();
  for (const entries of byIdentity.values()) {
    const accountMatches = entries.filter((entry) => entry.kind === 'account' || entry.kind === 'email');
    for (const { group } of accountMatches.length > 0 ? accountMatches : entries) {
      selectedGroups.set(group.key, group);
    }
  }
  return { groups: [...selectedGroups.values()] };
}
