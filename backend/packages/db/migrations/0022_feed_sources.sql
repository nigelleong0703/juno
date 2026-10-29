-- Feed sources: standing instructions the owner subscribes to (a daily brief, news topics, mail summary); each fires a
-- hidden routine that wakes the agent to post into the Feed. Owner-scoped document collection, same shape as 0009. Additive only.

CREATE TABLE IF NOT EXISTS feed_sources (
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

CREATE INDEX IF NOT EXISTS idx_feed_sources_owner_id ON feed_sources(owner_id);
CREATE INDEX IF NOT EXISTS idx_feed_sources_agent_id ON feed_sources(agent_id);
CREATE INDEX IF NOT EXISTS idx_feed_sources_at ON feed_sources(at DESC);
