-- 0040: the unsolicited messages an agent actually posted and what the owner did with them (daily cap, silence rule, snoozes). Same document-collection shape as every other table.

CREATE TABLE IF NOT EXISTS proactive_log (
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

CREATE INDEX IF NOT EXISTS idx_proactive_log_owner_id ON proactive_log(owner_id);
