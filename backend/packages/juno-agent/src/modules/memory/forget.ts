/**
 * Forgetting (BACKEND §5.4): the claims are retracted, and the items that came through them are deleted, so their lines leave the
 * views. An id that is an item's own (the `[mem:<id>]` tag of a line that has no claim) deletes that item. The raw conversations stay
 * (only what was derived from them goes), and a retracted claim is never written again because the hourly job drops anything that
 * repeats it. The next nightly job rewrites the synthesis.
 */
import type { ForgetMemoryResult } from '@agent-desktop/public-contracts';
import type { HomeDeps } from '../home/service.js';
import type { MemoryGraph } from './graph.js';
import { listAll } from './util.js';
import { renderViews } from './views.js';

const ITEM_ID = /^mem_[0-9a-f]{32}$/;

export async function forgetClaims(deps: HomeDeps & { memory: MemoryGraph }, input: { ownerId: string; agentId: string; claimIds: readonly string[] }): Promise<ForgetMemoryResult> {
  const { store, memory } = deps;
  const { ownerId } = input;
  const wanted = new Set(input.claimIds);
  const claims = (await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId && wanted.has(claim.id));
  const now = new Date().toISOString();
  let retracted = 0;
  for (const claim of claims) {
    if (claim.status === 'retracted') continue;
    await store.put('memoryClaims', { ...claim, status: 'retracted', updatedAt: now }, { status: 'retracted' });
    retracted += 1;
  }
  // A claim that replaced another leaves the old one superseded (its item retracted); forgetting the new one does not bring it back.
  const doomed = new Set<string>();
  for (const claim of claims) for (const item of await memory.items.listItems(ownerId, { claimId: claim.id })) doomed.add(item.id);
  for (const id of input.claimIds) if (ITEM_ID.test(id)) doomed.add(id);
  let removedLines = 0;
  for (const id of doomed) {
    const item = await memory.items.getItem(ownerId, id);
    if (item === undefined || !(await memory.items.deleteItem(ownerId, id))) continue;
    if (item.status === 'active') removedLines += 1;
  }
  if (doomed.size > 0) await renderViews(deps, { ownerId, agentId: input.agentId });
  return { retracted, removedLines };
}
