-- Add settings table for app-wide configuration

CREATE TABLE IF NOT EXISTS settings (
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

CREATE INDEX IF NOT EXISTS idx_settings_owner_id ON settings(owner_id);
CREATE INDEX IF NOT EXISTS idx_settings_agent_id ON settings(agent_id);
CREATE INDEX IF NOT EXISTS idx_settings_conversation_id ON settings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_settings_run_id ON settings(run_id);
CREATE INDEX IF NOT EXISTS idx_settings_status ON settings(status);
CREATE INDEX IF NOT EXISTS idx_settings_kind ON settings(kind);
CREATE INDEX IF NOT EXISTS idx_settings_parent_id ON settings(parent_id);
CREATE INDEX IF NOT EXISTS idx_settings_search ON settings USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_settings_at ON settings(at DESC);
