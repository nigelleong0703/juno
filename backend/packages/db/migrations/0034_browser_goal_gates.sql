-- Durable, owner-scoped browser stage completion; separate from probabilistic Jev decisions.
CREATE TABLE IF NOT EXISTS browser_goal_gates (
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
CREATE INDEX IF NOT EXISTS idx_browser_goal_gates_owner ON browser_goal_gates(owner_id, id);
CREATE INDEX IF NOT EXISTS idx_browser_goal_gates_run ON browser_goal_gates(run_id);
