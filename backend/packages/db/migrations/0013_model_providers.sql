-- Model providers: each owner's own model endpoints and API keys (one document per provider). Same
-- document-collection shape as 0010_devices. The API key lives sealed inside `doc` (enc:v1:); the
-- table holds no plaintext secret. Additive only: a new table + index.

CREATE TABLE IF NOT EXISTS model_providers (
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

CREATE INDEX IF NOT EXISTS idx_model_providers_owner_id ON model_providers(owner_id);
