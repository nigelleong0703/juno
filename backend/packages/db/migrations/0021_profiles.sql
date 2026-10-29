-- The account profile (BACKEND 8.7): names, emails, phones and addresses the agent fills into pages itself; one row per owner,
-- same document-collection shape as 0020_secure_vault. Additive only.

CREATE TABLE IF NOT EXISTS profiles (
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

CREATE INDEX IF NOT EXISTS idx_profiles_owner_id ON profiles(owner_id);
