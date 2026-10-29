-- Tasks agents declare with task_update (BACKEND 6.5). Additive only: new table, same shape as every
-- collection. Owner/agent/conversation scoped; deleted with its conversation (agentd conversation-delete).
CREATE TABLE IF NOT EXISTS agent_tasks (
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
CREATE INDEX IF NOT EXISTS idx_agent_tasks_owner_id ON agent_tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_conversation_id ON agent_tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_at ON agent_tasks(at DESC);
