/**
 * What deleting one agent removes besides its chats, goals, ideas, calendar, feed posts, routines and home mirror (BACKEND §5.2c): the
 * runs that are not in a deleted chat (background, memory and routine runs) with their steps and session transcripts, its app
 * toggles, tool-output artifacts, the artifacts it published with their files and drafts, its Spaces and share-link rows, and its audit
 * rows. The bytes of the files go through the same blob deletion the account wipe uses, and only when no row that stays names them.
 * The agent row and `agent.deleted` come after, from `deleteAgentCascade`.
 */
import { collectBlobKeys, deleteUnnamedBlobs } from '../account/blobs.js';
import { settled, type CascadeResult } from './conversation-delete.js';
import { rowsOf } from './relationships.js';
import { stopAgentRuns } from './runs.js';
import type { AgentdDeps } from './index.js';

const LIVE_STATUSES = ['running', 'queued', 'waiting_for_input'];

/** Stop every live run of the agent (children included) and wait until the rows are final, so no run patches rows we delete. Nothing is deleted when one will not stop. */
export async function stopAgentLiveRuns(deps: AgentdDeps, agentId: string): Promise<CascadeResult> {
  const live: string[] = [];
  for (const status of LIVE_STATUSES) for await (const run of rowsOf(deps.store, 'runs', { agentId, status })) live.push(run.id);
  if (live.length === 0) return { ok: true };
  await stopAgentRuns(deps, agentId);
  if (await settled(deps.store, live)) return { ok: true };
  return { ok: false, status: 409, code: 'RUNS_STILL_STOPPING', message: 'A running task is still stopping; nothing was deleted. Try again.' };
}

/** Delete the agent's rows named above in one transaction, then the blobs only they named. */
export async function deleteAgentData(deps: AgentdDeps, agentId: string): Promise<void> {
  const blobKeys = new Set<string>();
  await deps.store.tx(async (store) => {
    // Runs, wherever they ran (a deleted chat's runs are already gone), with their steps.
    for await (const run of rowsOf(store, 'runs', { agentId })) {
      for await (const step of rowsOf(store, 'steps', { runId: run.id })) await store.delete('steps', step.id);
      await store.delete('runs', run.id);
    }
    // Transcripts and compactions of the agent's sessions (`agentId:…`, sub-sessions included) that no chat delete reached: background, memory, routine and group-chat sessions.
    const ofAgent = (key: string): boolean => key.startsWith(agentId + ':');
    for await (const row of rowsOf(store, 'transcripts')) {
      if (!ofAgent(row.sessionKey)) continue;
      collectBlobKeys(row, blobKeys);
      await store.delete('transcripts', row.id);
    }
    for await (const row of rowsOf(store, 'compactions')) if (ofAgent(row.sessionKey)) await store.delete('compactions', row.id);

    for await (const row of rowsOf(store, 'agentApps', { agentId })) await store.delete('agentApps', row.id);
    for await (const row of rowsOf(store, 'artifacts', { agentId })) await store.delete('artifacts', row.id);
    for await (const row of rowsOf(store, 'audit', { agentId })) await store.delete('audit', row.id);
    for await (const row of rowsOf(store, 'spaceHosted', { agentId })) await store.delete('spaceHosted', row.id);
    for await (const row of rowsOf(store, 'spaces', { agentId })) await store.delete('spaces', row.id);

    // What it published or sent to the library: the row, every version's files, and the drafts proposed on a document.
    for await (const doc of rowsOf(store, 'library')) {
      if (doc.createdByAgentId !== agentId) continue;
      collectBlobKeys(doc, blobKeys);
      for (const version of doc.versions ?? []) {
        for (const ref of [version.fileRef, version.previewRef, version.thumbnailRef]) {
          if (ref === undefined) continue;
          const file = await store.get('artifactFiles', ref);
          if (file === null) continue;
          collectBlobKeys(file, blobKeys);
          await store.delete('artifactFiles', ref);
        }
      }
      for await (const draft of rowsOf(store, 'documentDrafts', { parentId: doc.id })) {
        collectBlobKeys(draft, blobKeys);
        await store.delete('documentDrafts', draft.id);
      }
      await store.delete('library', doc.id);
    }
    // Drafts it proposed on documents that stay (a person's, or another agent's).
    for await (const draft of rowsOf(store, 'documentDrafts', { agentId })) {
      collectBlobKeys(draft, blobKeys);
      await store.delete('documentDrafts', draft.id);
    }
  });
  // A row delete never deletes bytes (BACKEND §5.2a); here the rows are gone, so the bytes nothing else names go too. Without Postgres there is no way to ask, and they stay.
  if (deps.blobs !== undefined && deps.raw !== undefined && blobKeys.size > 0) await deleteUnnamedBlobs(deps.raw, deps.blobs, blobKeys);
}
