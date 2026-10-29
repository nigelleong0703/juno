/** Platform edits of files in the user's home (the memory jobs, forgetting): computer first, mirror always, pending when the computer is away. */
import type { HomeDeps } from '../home/service.js';
import { HomeConflictError, writeHomeFile } from '../home/service.js';
import { getRow } from '../home/mirror.js';

const ATTEMPTS = 3;

/**
 * Applies `transform` to the file's current text (empty when it does not exist) and saves the result as a platform write.
 * `transform` returns null to leave the file alone. A concurrent change (the user editing in the app) makes the write fail
 * its hash check; the edit is then redone on the new text, and as a last resort written over whatever the computer holds,
 * which is the mirror's version by the sync rules. Returns whether the file was written.
 */
export async function editHomeFile(
  deps: HomeDeps,
  input: { ownerId: string; agentId?: string; path: string },
  transform: (content: string) => string | null,
): Promise<boolean> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const row = await getRow(deps.store, input.ownerId, input.path);
    const next = transform(row?.content ?? '');
    if (next === null || next === (row?.content ?? '')) return false;
    try {
      await writeHomeFile(deps, { ...input, content: next, writer: 'platform', ...(row === null || attempt === ATTEMPTS ? {} : { expectedHash: row.hash }) });
      return true;
    } catch (error) {
      if (!(error instanceof HomeConflictError)) throw error;
    }
  }
  return false;
}
