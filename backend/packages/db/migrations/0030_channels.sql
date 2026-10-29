-- 0030: one messaging-platform identity per agent row (CH1 channels).
-- Same document-collection shape as every other table: id text primary key, owner/agent/conversation/run
-- indexed columns, kind/parent/at/search plus the doc jsonb. Telegram is the first adapter: one row per
-- bot, no public URL or app review needed.

CREATE TABLE IF NOT EXISTS channels (
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

CREATE INDEX IF NOT EXISTS idx_channels_owner_id ON channels(owner_id);
CREATE INDEX IF NOT EXISTS idx_channels_agent_id ON channels(agent_id);
CREATE INDEX IF NOT EXISTS idx_channels_at ON channels(at);
