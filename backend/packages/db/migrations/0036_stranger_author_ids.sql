-- 0036: a platform message from someone other than the owner is no longer stored as if the owner wrote it (contract 0.46.0).
-- Until now every platform message and every meeting line got `authorId = owner id` (the row's account), and only
-- `channelSender` said who really spoke. `authorId` is now the speaker: the owner's id for the owner, otherwise the
-- synthetic `ext-<kind>-<first 16 hex of sha256(externalId)>` (agentd `channelAuthorId`, same formula). This rewrites the
-- stranger rows already stored. The owner's own platform messages and every app message are untouched; a row that
-- already has a synthetic id is skipped, so the migration is safe to repeat.
UPDATE items
SET doc = jsonb_set(
      doc,
      '{authorId}',
      to_jsonb('ext-' || (doc->'channelSender'->>'kind') || '-' || substr(encode(sha256(convert_to(doc->'channelSender'->>'externalId', 'UTF8')), 'hex'), 1, 16))
    ),
    updated_at = NOW()
WHERE doc->>'type' = 'user_message'
  AND doc->'channelSender'->>'role' = 'stranger'
  AND doc->>'authorId' = owner_id;
