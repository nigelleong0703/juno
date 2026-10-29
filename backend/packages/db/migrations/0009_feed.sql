-- Feed: posts agents publish for the owner (news, progress). Owner-scoped document collection, same shape as 0008.
-- Additive only: a new table + indexes.

CREATE TABLE IF NOT EXISTS feed_posts (
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

CREATE INDEX IF NOT EXISTS idx_feed_posts_owner_id ON feed_posts(owner_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_agent_id ON feed_posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_conversation_id ON feed_posts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_run_id ON feed_posts(run_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_status ON feed_posts(status);
CREATE INDEX IF NOT EXISTS idx_feed_posts_kind ON feed_posts(kind);
CREATE INDEX IF NOT EXISTS idx_feed_posts_parent_id ON feed_posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_feed_posts_search ON feed_posts USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_feed_posts_at ON feed_posts(at DESC);
