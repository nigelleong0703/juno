-- Per-agent screens inside the shared computer (SB1). Backend-only: VNC secrets are derived,
-- not stored, so a screen row is safe to read.
CREATE TABLE IF NOT EXISTS screens (
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

CREATE INDEX IF NOT EXISTS idx_screens_owner_id ON screens(owner_id);
CREATE INDEX IF NOT EXISTS idx_screens_agent_id ON screens(agent_id);
CREATE INDEX IF NOT EXISTS idx_screens_conversation_id ON screens(conversation_id);
CREATE INDEX IF NOT EXISTS idx_screens_run_id ON screens(run_id);
CREATE INDEX IF NOT EXISTS idx_screens_status ON screens(status);
CREATE INDEX IF NOT EXISTS idx_screens_kind ON screens(kind);
CREATE INDEX IF NOT EXISTS idx_screens_parent_id ON screens(parent_id);
CREATE INDEX IF NOT EXISTS idx_screens_search ON screens USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_screens_at ON screens(at DESC);

