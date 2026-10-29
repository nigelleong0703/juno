-- Memory index and claims (BACKEND 5.2). Additive only: two new tables with the same shape as every collection.
-- memory_entries.kind = file path (replace the chunks of one file), memory_claims.status = active|superseded|retracted.
CREATE TABLE IF NOT EXISTS memory_entries (
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
CREATE INDEX IF NOT EXISTS idx_memory_entries_owner_id ON memory_entries(owner_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_kind ON memory_entries(kind);

CREATE TABLE IF NOT EXISTS memory_claims (
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
CREATE INDEX IF NOT EXISTS idx_memory_claims_owner_id ON memory_claims(owner_id);
CREATE INDEX IF NOT EXISTS idx_memory_claims_status ON memory_claims(status);
CREATE INDEX IF NOT EXISTS idx_memory_claims_at ON memory_claims(at DESC);
