// Agent team (roster) and wake rendering for the context.
// Directory policy: the owner's own agents only. Unknown ownership closes the
// team instead of opening it. The team is a context section of its own (BACKEND 6.1a): its text is a function of the
// roster alone (names, roles, the one-line description), never of what an agent is doing right now, so it is re-sent
// only when an agent is added, renamed or given a new role.
import type { Agent } from '@agent-desktop/public-contracts';
import type { ListPage, Store, WakeEvent } from '../../contracts/index.js';
import { harnessText } from '../../modules/harness/loader.js';
import { meaningfulRole, quoteId, quoteLabel, whoLine } from './social-format.js';
import { readString } from './social-read.js';

// Max agent docs scanned for the team.
const ROSTER_SCAN_LIMIT = 100;
// Max team entries rendered before a truthful truncation note.
const MAX_ROSTER_SHOWN = 20;

interface Teammate {
  id: string;
  name: string | undefined;
  handle: string | undefined;
  role: string | undefined;
  /** The owner's one-line description of the agent: what it handles. */
  handles: string | undefined;
}

/** The first line of the description, when there is one. */
function handlesOf(description: string | undefined): string | undefined {
  const first = description?.split('\n')[0]?.trim() ?? '';
  return first === '' ? undefined : first;
}

/** Owner runs see the id (to hand work over), the handle and what the teammate handles; other runs see its name and role only. */
function teamEntry(peer: Teammate, ownerOnly: boolean): string {
  if (!ownerOnly) return quoteLabel(peer.name) + (peer.role === undefined ? '' : ', role ' + quoteLabel(peer.role));
  const who = whoLine(peer.name, peer.handle, peer.id) + ', id ' + quoteId(peer.id);
  const role = peer.role === undefined ? '' : ', role ' + quoteLabel(peer.role);
  return who + role + (peer.handles === undefined ? '' : ', handles ' + quoteLabel(peer.handles));
}

/**
 * The team section of a run: the owner's other agents. `ownerId` is the owner the run is authorized for (undefined: withheld).
 * Owner-only runs get ids, handles and what each teammate handles, with the rule to hand work over. Every other run gets names
 * and roles only, which are public-safe: no ids, no descriptions.
 */
export async function teamSection(store: Store, selfId: string, ownerId: string | undefined, ownerOnly: boolean): Promise<string> {
  const lines = [harnessText('social.roster.header')];
  if (ownerId === undefined) {
    lines.push(harnessText('social.roster.unavailable_owner'));
    return lines.join('\n');
  }
  let page: ListPage<Agent>;
  try {
    page = await store.list('agents', { limit: ROSTER_SCAN_LIMIT, orderBy: 'id' });
  } catch {
    lines.push(harnessText('social.roster.unavailable_list'));
    return lines.join('\n');
  }
  const peers: Teammate[] = [];
  let unverified = 0;
  for (const candidate of page.items) {
    if (candidate.id === selfId) continue;
    const candidateOwner = readString(candidate, 'ownerId');
    if (candidateOwner === undefined) {
      if (readString(candidate, 'createdBy') !== ownerId) continue;
      unverified += 1;
    } else if (candidateOwner !== ownerId) {
      continue;
    }
    peers.push({
      id: candidate.id,
      name: readString(candidate, 'name'),
      handle: readString(candidate, 'handle'),
      role: meaningfulRole(readString(candidate, 'title')),
      handles: handlesOf(readString(candidate, 'description')),
    });
  }
  // Sorted by name, then id, so the text never depends on the order the store lists rows in.
  peers.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));
  if (peers.length === 0) {
    lines.push(harnessText('social.roster.none_visible'));
  } else {
    lines.push(harnessText(ownerOnly ? 'social.roster.agents_owner' : 'social.roster.agents_public'));
    for (const peer of peers.slice(0, MAX_ROSTER_SHOWN)) lines.push('  - ' + teamEntry(peer, ownerOnly));
  }
  if (peers.length > MAX_ROSTER_SHOWN) {
    lines.push(harnessText('social.roster.truncated', { more: String(peers.length - MAX_ROSTER_SHOWN), limit: String(MAX_ROSTER_SHOWN) }));
  }
  if (page.nextCursor !== undefined) {
    lines.push(harnessText('social.roster.scan_capped', { limit: String(ROSTER_SCAN_LIMIT) }));
  }
  if (unverified > 0) {
    lines.push(harnessText('social.roster.unverified', { count: String(unverified) }));
  }
  if (ownerOnly && peers.length > 0) {
    lines.push(harnessText('social.roster.handoff'));
  }
  lines.push(harnessText('social.roster.directory_data'));
  return lines.join('\n');
}

/**
 * What woke this run, for the run-start line of a context note. The wake id is deliberately absent:
 * it differs every run, and the wake message itself already sits in the transcript.
 */
export function wakeSummary(wake: WakeEvent[]): string[] {
  const first = wake[0];
  if (first === undefined) return [];
  const from = first.origin.id === undefined ? first.origin.type : first.origin.type + " '" + first.origin.id + "'";
  const tag = first.origin.label === undefined ? '' : ' (' + quoteLabel(first.origin.label) + ')';
  const lines = ['Woken by: kind ' + quoteId(first.kind) + ', from ' + from + tag + ', ' + (first.trusted ? 'trusted' : 'untrusted') + '.'];
  if (first.reason !== undefined && first.reason.length > 0) lines.push('Wake reason: ' + quoteLabel(first.reason) + '.');
  return lines;
}
