-- 0031: live meetings an agent's channel app attends (CH8, Lark). Same document-collection shape as every
-- other table; `status` (invited / active / ended), `agent_id` and `conversation_id` are the indexed columns.

CREATE TABLE IF NOT EXISTS meeting_sessions (
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

CREATE INDEX IF NOT EXISTS idx_meeting_sessions_owner_id ON meeting_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_agent_id ON meeting_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_status ON meeting_sessions(status);
