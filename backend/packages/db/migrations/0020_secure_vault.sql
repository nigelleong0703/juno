-- The names (never the values) of the vault fields an owner keeps on the phone, for secure input (BACKEND 8.7):
-- one row per owner, same document-collection shape as 0013_model_providers. Additive only.

CREATE TABLE IF NOT EXISTS secure_vault (
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

CREATE INDEX IF NOT EXISTS idx_secure_vault_owner_id ON secure_vault(owner_id);
