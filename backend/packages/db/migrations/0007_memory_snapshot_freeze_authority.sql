-- Distributed first-freeze authority for memory snapshots, compatible with
-- legacy rows.
--
-- Live preflight found real legacy snapshots frozen without a sessionKey
-- (four duplicated owner groups) that must keep working untouched: no
-- backfill, no rewrite, no delete. A blanket unique index would refuse to
-- build on those rows, so authority covers only session-keyed freezes, which
-- is every production freeze (buildContext and the frozen strategy always
-- pass a sessionKey). The agent-row SELECT ... FOR UPDATE serializes freezers
-- when the agent row exists; when it is missing, losers take SQLSTATE 23505
-- from this index and converge on the committed winner instead of throwing.
-- Sessionless creation is refused in code (a freeze without a session has no
-- authority key) while existing unattributed rows stay readable through the
-- legacy reuse path. Purely additive: no existing index, constraint, table,
-- or event row-lock is touched.
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_snapshots_freeze_authority
  ON memory_snapshots (
    owner_id,
    COALESCE(agent_id, ''),
    COALESCE(doc->>'compactionEpoch', ''),
    COALESCE(doc->>'sessionKey', '')
  )
  WHERE COALESCE(doc->>'sessionKey', '') <> '';
