-- Background jobs the agent started (shell processes, MCP background calls, wait_for notify), so the
-- model can list and stop them after compaction (tasks_list / task_stop). Additive only: new table.
-- Owner/agent/conversation scoped; deleted with its conversation (agentd conversation-delete).
CREATE TABLE IF NOT EXISTS background_tasks (
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

CREATE INDEX IF NOT EXISTS idx_background_tasks_owner_id ON background_tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_background_tasks_agent_id ON background_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_background_tasks_conversation_id ON background_tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_background_tasks_at ON background_tasks(at DESC);
