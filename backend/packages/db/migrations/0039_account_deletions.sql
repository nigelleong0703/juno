-- 0038: accounts whose deletion has started (the "deleting" state a restart finishes). Same document-collection shape as every other table.
CREATE TABLE IF NOT EXISTS account_deletions (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_deletions_owner ON account_deletions(owner_id, id);
