/** Cleans the synthesis the model wrote before it replaces ALIGNMENT_SYNTHESIS.md (BACKEND §5.4, §5.7.6). */
import type { MemoryClaimStatus } from '@agent-desktop/public-contracts';
import { agentSectionId } from '../../home/render.js';
import { claimIdOfLine, claimTag } from '../claims.js';

/**
 * Drops sections written for agents that no longer exist, lines that rest on a retracted claim, and tags of claims that do not
 * exist (the model invented them). `statuses` maps every known claim id to its status.
 */
export function sanitizeAlignment(text: string, input: { agentIds: ReadonlySet<string>; statuses: ReadonlyMap<string, MemoryClaimStatus> }): string {
  const kept: string[] = [];
  let keep = true;
  for (const raw of text.split('\n')) {
    const heading = agentSectionId(raw);
    if (heading !== undefined) keep = input.agentIds.has(heading);
    else if (raw.startsWith('## ')) keep = true;
    if (!keep) continue;
    const id = claimIdOfLine(raw);
    const status = id === undefined ? undefined : input.statuses.get(id);
    if (id !== undefined && status === 'retracted') continue;
    kept.push(id !== undefined && status === undefined ? raw.replace(claimTag(id), '').trimEnd() : raw);
  }
  return kept.join('\n').trim() + '\n';
}
