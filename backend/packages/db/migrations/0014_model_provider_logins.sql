-- Pending ChatGPT sign-ins for model providers: one row per started login, consumed on completion and
-- expired after ten minutes. Same document-collection shape as 0013_model_providers. Additive only.

CREATE TABLE IF NOT EXISTS model_provider_logins (
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

CREATE INDEX IF NOT EXISTS idx_model_provider_logins_owner_id ON model_provider_logins(owner_id);
