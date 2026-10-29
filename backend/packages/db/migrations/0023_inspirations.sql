-- Today inspirations (BACKEND 10.10b): per owner, when each suggestion was first shown and whether it was dismissed.
-- Owner-scoped document collection, same shape as 0021. Additive only.

CREATE TABLE IF NOT EXISTS inspirations (
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

CREATE INDEX IF NOT EXISTS idx_inspirations_owner_id ON inspirations(owner_id);
