-- Agent home mirror (BACKEND 5.2): index and backup of the files in the user's computer (USER.md, agent text files, memory,
-- skills projection). Additive only: new table, same shape as every collection; owner scoped, agent_id set for per-agent files.
CREATE TABLE IF NOT EXISTS agent_home (
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
CREATE INDEX IF NOT EXISTS idx_agent_home_owner_id ON agent_home(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_home_agent_id ON agent_home(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_home_conversation_id ON agent_home(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_home_at ON agent_home(at DESC);

