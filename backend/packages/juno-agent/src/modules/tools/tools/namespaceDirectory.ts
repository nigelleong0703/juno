// Bounded namespace directory for compact disclosure.
import { createHash } from 'node:crypto';
import type { Tool } from '../../../contracts/index.js';
export const CORE_TOOL_NAMES: readonly string[] = [
  'send_message',
  'tool_search',
  'tool_load',
  'tool_call',
  'skill_search',
  'skill_read',
  // Delegation is a first-step orchestration decision, available without discovery.
  'child_spawn',
  'todo_write',
  // Who someone is and what they said (memory graph, batch 7): the connections part is shown only where the owner is alone (personLookup.ts).
  'person_lookup',
  // The owner's goals, recorded in the turn (ownerOnly: shown only where the owner is alone with the agent).
  'goal_update',
  // Busy times only, offered where the owner is not alone with the agent (batch 5b, scope.ts).
  'calendar_free_busy',
  // Stable harness-owned interaction primitives; infrequent computer tools remain discoverable.
  'browser.advance', 'browser.navigate', 'browser.snapshot', 'browser.click',
  'browser.type', 'browser.fill', 'browser.get_text', 'browser.dialog',
  'computer.screenshot', 'computer.click', 'computer.type', 'computer.key', 'computer.scroll',
  // Only an agent allowed on the Mac is offered these (index.ts hides them otherwise).
  'computer.snapshot', 'computer.act', 'computer.verify',
];
export type DisclosureMode = 'off' | 'legacy' | 'compact';
export function disclosureMode(env: Record<string, string | undefined> = process.env): DisclosureMode {
  const raw = env['TOOL_DISCLOSURE'];
  if (raw === 'off') return 'off';
  if (raw === 'legacy') return 'legacy';
  return 'compact';
}
// True when the tool stays model-visible in the compact default: core names,
// or a custom stub without any marker. Production non-core builtins set
// deferLoading; MCP tools default to deferred unless explicitly opted back.
export function isCompactVisible(tool: Tool): boolean {
  if (CORE_TOOL_NAMES.indexOf(tool.name) !== -1) return true;
  if (tool.mcp === true) return tool.deferLoading === false;
  return tool.deferLoading !== true;
}
function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'unnamed' : cleaned;
}
function stripStars(value: string): string {
  let out = value.trim();
  while (out.endsWith('*')) out = out.slice(0, out.length - 1);
  return out.trim();
}
export interface NamespaceGroup {
  namespace: string;
  key: string;
  connectionName?: string;
  account?: string;
  tools: Tool[];
}
// Deferred tools only: the directory describes what the core view hides, grouped
// by connection (one group per connection id; same-connector accounts share a base
// display namespace with an account suffix) or by builtin family (browser, files,
// shell, computer, memory, ...). Short capability summary only: each line names
// at most a few real tools; the full list lives behind scoped tool_search.
function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 4);
}
function builtinFamily(name: string): string {
  const dotted = name.split('.')[0];
  const head = (dotted === undefined ? name : dotted).split('_')[0];
  return slug(head === undefined || head === '' ? name : head);
}
function disambiguateAccountNamespaces(groups: Map<string, NamespaceGroup>): void {
  const bases = new Map<string, NamespaceGroup[]>();
  for (const group of groups.values()) {
    if (!group.key.startsWith('mcp:')) continue;
    const list = bases.get(group.namespace);
    if (list === undefined) bases.set(group.namespace, [group]);
    else list.push(group);
  }
  for (const list of bases.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const used = new Set<string>();
    for (const group of list) {
      const connectionId = group.key.slice(4);
      const raw = group.account === undefined ? '' : slug(group.account).slice(0, 16);
      const stem = stripStars(group.namespace).replace(/_+$/, '');
      let candidate = raw === '' ? stem + '_' + shortHash(connectionId) + '__*' : stem + '__' + raw + '__*';
      if (used.has(candidate)) candidate = stem + '__' + (raw === '' ? '' : raw + '_') + shortHash(connectionId) + '__*';
      used.add(candidate);
      group.namespace = candidate;
    }
  }
}
export function groupNamespaces(tools: readonly Tool[]): NamespaceGroup[] {
  const groups = new Map<string, NamespaceGroup>();
  for (const tool of tools) {
    if (isCompactVisible(tool)) continue;
    const origin = tool.origin;
    if (origin === undefined) {
      const family = builtinFamily(tool.name);
      const familyKey = 'builtin:' + family;
      let fam = groups.get(familyKey);
      if (fam === undefined) {
        fam = { namespace: family, key: familyKey, tools: [] };
        groups.set(familyKey, fam);
      }
      fam.tools.push(tool);
      continue;
    }
    const source = origin.catalogId !== undefined && origin.catalogId !== '' ? origin.catalogId : origin.connectionName;
    const key = 'mcp:' + origin.connectionId;
    let group = groups.get(key);
    if (group === undefined) {
      group = { namespace: 'mcp__' + slug(source) + '__*', key, tools: [] };
      const label = origin.connectionName.trim();
      if (label !== '') group.connectionName = label.slice(0, 48);
      const account = origin.account === undefined ? '' : origin.account.trim();
      if (account !== '') group.account = account.slice(0, 48);
      groups.set(key, group);
    }
    group.tools.push(tool);
  }
  disambiguateAccountNamespaces(groups);
  const out = [...groups.values()];
  for (const group of out) group.tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.sort((a, b) => {
    if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
    const aa = a.account === undefined ? '' : a.account;
    const bb = b.account === undefined ? '' : b.account;
    if (aa !== bb) return aa < bb ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}
// Resolve a namespace filter to groups, both sides slug-normalized so display
// underscores and filter underscores compare alike. The exact display form
// (mcp__gmail__work__*) names one group; the bare connector slug (gmail) or
// connection name matches every labeled group of that connector; anything else
// matches nothing. Never guesses.
export function matchNamespace(groups: readonly NamespaceGroup[], filter: string): NamespaceGroup[] {
  const q = slug(stripStars(filter));
  if (q === '' || q === 'unnamed') return [];
  const out: NamespaceGroup[] = [];
  for (const group of groups) {
    const g = slug(stripStars(group.namespace));
    if (g === q) {
      out.push(group);
      continue;
    }
    if (g === 'mcp_' + q || g.indexOf('mcp_' + q + '_') === 0) {
      out.push(group);
      continue;
    }
    const conn = group.connectionName === undefined ? '' : slug(group.connectionName);
    if (conn !== '' && conn !== 'unnamed' && conn === q) out.push(group);
  }
  return out;
}
// A group with at most this many tools lists every canonical name; a bigger one (a large connector) lists only its namespace, meta and count.
const MAX_LISTED_GROUP_TOOLS = 8;
function groupLine(group: NamespaceGroup, wireName: ((name: string) => string) | undefined): string {
  const native = wireName !== undefined;
  const names = group.tools.map((tool) => (wireName === undefined ? tool.name : wireName(tool.name)));
  let head = '- ' + group.namespace;
  const who = group.connectionName === undefined ? '' : group.connectionName;
  const acct = group.account === undefined ? '' : group.account;
  const meta = who === '' && acct === '' ? '' : ' (' + (who === '' ? acct : acct === '' ? who : who + ', ' + acct) + ')';
  head += meta + ' (' + String(names.length) + (names.length === 1 ? ' tool' : ' tools') + ')';
  return names.length <= MAX_LISTED_GROUP_TOOLS ? head + ': ' + names.join(', ') : head + (native ? ': find them with tool_search' : ': list with tool_search namespace filter');
}
// Layer 1 of progressive disclosure: deterministic and COMPLETE (every group, no budget). Small groups list all
// canonical names; large ones give the count and point at tool_search (layer 2: names + descriptions; layer 3: schema).
// A model with native deferred loading calls a found tool by its own name (`wireName` maps a registry name to the name
// on the wire, the one the model sees in the loaded definition); the others run it with tool_call.
export function renderNamespaceDirectory(groups: readonly NamespaceGroup[], wireName?: (name: string) => string): string {
  const native = wireName !== undefined;
  const lines = [native
    ? 'Namespace directory (hidden tools by connected app or family; a namespace is only a hint for tool_search, never part of a tool name; the names below are the tools you can call once tool_search has loaded them; this list grants nothing by itself):'
    : 'Namespace directory (each entry is a tool_search namespace FILTER ONLY, never a call prefix: do not prepend it to a tool name; the canonical tool names below stay valid for tool_call; this list grants nothing by itself):'];
  for (const group of groups) lines.push(groupLine(group, wireName));
  lines.push(native
    ? 'Find a tool with tool_search (say what you want to do), then call it by its name. Hidden tools keep full policy and approval.'
    : 'List one namespace with tool_search (namespace filter, query empty or a few words); get the schemas of tools you know by exact name with tool_load; run a tool with tool_call. Hidden tools keep full policy and approval.');
  return lines.join('\n');
}
