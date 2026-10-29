-- 0033: installs of the shared Juno Slack app / Discord bot, one row per workspace / server (channel unification).
-- Same document-collection shape as every other table.

CREATE TABLE IF NOT EXISTS channel_installations (
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

CREATE INDEX IF NOT EXISTS idx_channel_installations_owner_id ON channel_installations(owner_id);
CREATE INDEX IF NOT EXISTS idx_channel_installations_at ON channel_installations(at);
