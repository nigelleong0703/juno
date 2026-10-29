import { createHash } from 'node:crypto';

/**
 * The `authorId` a platform message is stored with (contract 0.46.0): the owner's id when the bound owner spoke, otherwise a stable
 * synthetic id for that outside speaker, `ext-<kind>-<first 16 hex of sha256(externalId)>`. The DB owner_id column still scopes the row.
 * Migration PG 0036 rewrote the older rows with the same formula, so keep the two in step.
 */
export function channelAuthorId(ownerId: string, speaker: { role: 'owner' | 'stranger'; kind: string; externalId: string }): string {
  if (speaker.role === 'owner') return ownerId;
  return 'ext-' + speaker.kind + '-' + createHash('sha256').update(speaker.externalId).digest('hex').slice(0, 16);
}
