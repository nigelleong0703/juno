/**
 * One-time move of the old agent text fields and `general.aboutMe` into home mirror rows (BACKEND §5.5). The rows are pending
 * writes, so they reach each computer on its next sync. The old fields stay where they are and are no longer read. Rows that
 * already exist are never overwritten, and a marker row makes later boots skip all of it.
 */
import { z } from 'zod';
import type { Store } from '../../contracts/index.js';
import { settingsIdFor } from '@agent-desktop/public-contracts';
import { listAll } from '../memory/util.js';
import { getRow, newRow, putRow, rowId } from './mirror.js';
import { USER_FILE } from './paths.js';
import { seedAgentFiles } from './service.js';

export const MARKER = '__migrations/home-v1';

const legacyAgent = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  createdBy: z.string().optional(),
  personality: z.string().optional(),
  principles: z.string().optional(),
  instructions: z.string().optional(),
  toolNotes: z.string().optional(),
  proactivePreferences: z.string().optional(),
});
const legacySettings = z.object({ id: z.string(), general: z.object({ aboutMe: z.string().optional() }).optional() });

/** Returns how many rows it created; 0 and no writes when the marker is there. Pass the raw (unscoped) store. */
export async function migrateHomeFiles(store: Store): Promise<number> {
  if ((await store.get('agentHome', rowId('system', MARKER))) !== null) return 0;
  let created = 0;
  for (const raw of await listAll(store, 'agents')) {
    const agent = legacyAgent.safeParse(raw);
    const ownerId = agent.success ? agent.data.ownerId ?? agent.data.createdBy : undefined;
    if (!agent.success || ownerId === undefined) continue;
    // Whole agent at a time: a half-seeded agent is finished by the next boot only if the marker is missing, and seeding skips none, so guard on IDENTITY/SOUL/AGENTS/TOOLS existing.
    const existing = await Promise.all(['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md'].map((file) => getRow(store, ownerId, 'agents/' + agent.data.id + '/' + file)));
    if (existing.some((row) => row !== null)) continue;
    created += (await seedAgentFiles(store, ownerId, agent.data.id, agent.data)).length;
  }
  for (const raw of await listAll(store, 'settings')) {
    const parsed = legacySettings.safeParse(raw);
    const aboutMe = parsed.success ? parsed.data.general?.aboutMe?.trim() ?? '' : '';
    const prefix = settingsIdFor('');
    const ownerId = parsed.success && parsed.data.id.startsWith(prefix) ? parsed.data.id.slice(prefix.length) : '';
    if (ownerId.length === 0 || aboutMe.length === 0) continue;
    if ((await getRow(store, ownerId, USER_FILE)) !== null) continue;
    await putRow(store, newRow(ownerId, USER_FILE, aboutMe, 'user', new Date().toISOString(), true));
    created += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return created;
}
