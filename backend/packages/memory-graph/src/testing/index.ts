/**
 * Fixtures for tests (package export `./testing`): a throwaway Postgres with every migration applied, and the owner and their
 * contacts written through the identity service, so they follow the same rules as production data. A contact is created by its
 * first account; its other accounts are linked to it.
 */
import type { DurableDb } from '@agent-desktop/durable';
import { createIdentity, type Account, type AccountInput, type Person } from '../identity/index.js';

export { startTestDatabase, type TestDatabase } from './database.js';
export { seedSkill, type SkillSeed } from './skills.js';

export interface ContactSeed {
  name: string;
  accounts: [AccountInput, ...AccountInput[]];
}

export interface PeopleSeed {
  ownerName?: string;
  contacts?: ContactSeed[];
}

export interface SeededPeople {
  owner: Person;
  contacts: Array<{ person: Person; accounts: Account[] }>;
}

export async function seedPeople(db: DurableDb, ownerId: string, seed: PeopleSeed = {}): Promise<SeededPeople> {
  const identity = createIdentity(db);
  const owner = await identity.ensureOwner(ownerId, seed.ownerName ?? 'Owner');
  const contacts: SeededPeople['contacts'] = [];
  for (const contact of seed.contacts ?? []) {
    const [first, ...rest] = contact.accounts;
    const seen = await identity.upsertAccount(ownerId, { ...first, name: contact.name }, { createPerson: true });
    const person = seen.person;
    if (person === undefined) throw new Error('the first account of a contact gets a person');
    const accounts: Account[] = [seen.account];
    for (const input of rest) {
      const more = await identity.upsertAccount(ownerId, input, { createPerson: false });
      accounts.push(await identity.linkAccount(ownerId, more.account.id, person.id));
    }
    contacts.push({ person, accounts });
  }
  return { owner, contacts };
}
