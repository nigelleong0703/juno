-- Spaces (BACKEND 5.12): small apps agents build in their own computer and publish with space_publish. Additive only:
-- new table, same shape as every collection. agent_id = the agent that owns the app; parent_id = its chat card
-- (a library row with render 'app'); status = allocated | published.
CREATE TABLE IF NOT EXISTS spaces (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spaces_owner_id ON spaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_spaces_agent_id ON spaces(agent_id);
CREATE INDEX IF NOT EXISTS idx_spaces_at ON spaces(at DESC);
