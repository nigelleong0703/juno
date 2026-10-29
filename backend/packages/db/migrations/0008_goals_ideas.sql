-- Goals and ideas: owner-scoped document collections (same shape as the other doc tables).
-- Additive only: new tables + indexes.

CREATE TABLE IF NOT EXISTS goals (
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

CREATE INDEX IF NOT EXISTS idx_goals_owner_id ON goals(owner_id);
CREATE INDEX IF NOT EXISTS idx_goals_agent_id ON goals(agent_id);
CREATE INDEX IF NOT EXISTS idx_goals_conversation_id ON goals(conversation_id);
CREATE INDEX IF NOT EXISTS idx_goals_run_id ON goals(run_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_kind ON goals(kind);
CREATE INDEX IF NOT EXISTS idx_goals_parent_id ON goals(parent_id);
CREATE INDEX IF NOT EXISTS idx_goals_search ON goals USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_goals_at ON goals(at DESC);

CREATE TABLE IF NOT EXISTS ideas (
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

CREATE INDEX IF NOT EXISTS idx_ideas_owner_id ON ideas(owner_id);
CREATE INDEX IF NOT EXISTS idx_ideas_agent_id ON ideas(agent_id);
CREATE INDEX IF NOT EXISTS idx_ideas_conversation_id ON ideas(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ideas_run_id ON ideas(run_id);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_kind ON ideas(kind);
CREATE INDEX IF NOT EXISTS idx_ideas_parent_id ON ideas(parent_id);
CREATE INDEX IF NOT EXISTS idx_ideas_search ON ideas USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_ideas_at ON ideas(at DESC);
