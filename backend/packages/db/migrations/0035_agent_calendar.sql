-- 0035: the agent's own calendar (one-off follow-ups, meetings, tasks). Same document-collection shape as every other table.

CREATE TABLE IF NOT EXISTS agent_calendar (
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

CREATE INDEX IF NOT EXISTS idx_agent_calendar_owner_id ON agent_calendar(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_calendar_agent_at ON agent_calendar(agent_id, at);
