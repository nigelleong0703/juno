/**
 * The owner's own person (BACKEND §9.5): one per owner, created when the owner's account starts (onboarding) and by a one-off boot
 * backfill for every existing owner. Items about the owner point at this person (`about_person_id`), so every reader can name them.
 */
import type { Person } from '@agent-desktop/memory-graph/identity';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { readProfile } from '../profile/index.js';
import { getRow, newRow, putRow } from '../home/mirror.js';
import type { MemoryGraph } from './graph.js';
import { listAll } from './util.js';

/** The name the owner's person gets when nothing better is known (the sign-up name is the profile's "Name" entry). */
export const OWNER_FALLBACK_NAME = 'Owner';

export const BACKFILL_MARKER = '__migrations/owner-person-v1';

/** The owner's name from their profile ("Name", typed at sign-up), else the fallback. */
export async function ownerNameOf(store: Store, ownerId: string): Promise<string> {
  const name = (await readProfile(store, ownerId))?.entries.find((entry) => entry.key.trim().toLowerCase() === 'name')?.value.trim();
  return name === undefined || name === '' ? OWNER_FALLBACK_NAME : name;
}

/** The owner's person, made if it does not exist yet (idempotent: an existing one keeps its name). */
export async function ensureOwnerPerson(memory: MemoryGraph, store: Store, ownerId: string): Promise<Person> {
  return memory.identity.ensureOwner(ownerId, await ownerNameOf(store, ownerId));
}

/**
 * One-off boot backfill: every owner who has an agent gets their own person. The sign-up name is not stored anywhere but the profile
 * (and the account, which agentd does not read), so an existing owner gets the profile's name or the fallback. Leaves a marker row.
 */
export async function backfillOwnerPeople(store: Store, memory: MemoryGraph): Promise<{ skipped: boolean; owners: number }> {
  if ((await getRow(store, 'system', BACKFILL_MARKER)) !== null) return { skipped: true, owners: 0 };
  const owners = new Set<string>();
  for (const agent of await listAll(store, 'agents')) {
    const ownerId = docOwner(agent);
    if (ownerId !== undefined && ownerId !== '') owners.add(ownerId);
  }
  for (const ownerId of owners) await ensureOwnerPerson(memory, store, ownerId);
  await putRow(store, newRow('system', BACKFILL_MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, owners: owners.size };
}
