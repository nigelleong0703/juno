-- 0038: what an agent-created monitor remembers between checks (seen item ids, failure counters). Same document-collection shape as every other table.

CREATE TABLE IF NOT EXISTS monitor_state (
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

CREATE INDEX IF NOT EXISTS idx_monitor_state_owner_id ON monitor_state(owner_id);
