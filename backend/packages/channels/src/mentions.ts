/**
 * Outbound mentions: the agent writes `@handle` or `@Name`, the platform needs its own syntax (`<@id>` ...). Resolution is done
 * against the people the channel layer already knows for the chat, in two steps so the markdown converters cannot mangle the
 * platform syntax: `markMentions` swaps each resolved `@term` for a private-use placeholder, `renderMentions` swaps the
 * placeholder for the platform's syntax after conversion. A term that is unknown or names more than one person stays plain text;
 * a handle is unique, so it wins over a display name that happens to equal it.
 */
import type { ChannelPerson } from './types.js';

const OPEN = '';
const SEP = '';
const CLOSE = '';
const PLACEHOLDER = new RegExp(OPEN + '([^' + SEP + ']*)' + SEP + '([^' + CLOSE + ']*)' + CLOSE, 'g');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The people a term (lower case) resolves to uniquely: handles first, then display names that name exactly one person. */
function resolveTerms(people: ChannelPerson[]): Map<string, ChannelPerson> {
  const unique = new Map<string, ChannelPerson>();
  for (const person of people) if (!unique.has(person.id)) unique.set(person.id, person);
  const handles = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, term: string | undefined, id: string): void => {
    const key = term?.trim().toLowerCase();
    if (key === undefined || key === '') return;
    into.set(key, (into.get(key) ?? new Set<string>()).add(id));
  };
  for (const person of unique.values()) {
    add(handles, person.handle, person.id);
    add(names, person.name, person.id);
  }
  const resolved = new Map<string, ChannelPerson>();
  for (const [term, ids] of handles) {
    const only = ids.size === 1 ? unique.get([...ids][0] ?? '') : undefined;
    if (only !== undefined) resolved.set(term, only);
  }
  for (const [term, ids] of names) {
    if (resolved.has(term) || handles.has(term)) continue;
    const only = ids.size === 1 ? unique.get([...ids][0] ?? '') : undefined;
    if (only !== undefined) resolved.set(term, only);
  }
  return resolved;
}

export function markMentions(text: string, people: ChannelPerson[]): string {
  if (people.length === 0 || !text.includes('@')) return text;
  const resolved = resolveTerms(people);
  if (resolved.size === 0) return text;
  const terms = [...resolved.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp('(?<![\\p{L}\\p{N}_@<' + OPEN + SEP + '])@(' + terms.join('|') + ')(?![\\p{L}\\p{N}_])', 'giu');
  return text.replace(pattern, (whole, term: string) => {
    const person = resolved.get(term.toLowerCase());
    return person === undefined ? whole : OPEN + person.id + SEP + person.name + CLOSE;
  });
}

/** Placeholders to the platform's syntax (`render`), or a plain `@Name` when the platform has none. */
export function renderMentions(text: string, render?: (person: ChannelPerson) => string): string {
  return text.replace(PLACEHOLDER, (_whole, id: string, name: string) => (render === undefined ? '@' + name : render({ id, name })));
}
