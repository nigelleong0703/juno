-- Bytes of each published artifact version (artifact_publish, BACKEND 5.11): the file, its PDF preview and its
-- first-page PNG. Additive only: new table, same shape as every collection. parent_id = the artifact (library row) id.
CREATE TABLE IF NOT EXISTS artifact_files (
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
CREATE INDEX IF NOT EXISTS idx_artifact_files_owner_id ON artifact_files(owner_id);
CREATE INDEX IF NOT EXISTS idx_artifact_files_parent_id ON artifact_files(parent_id);
CREATE INDEX IF NOT EXISTS idx_artifact_files_at ON artifact_files(at DESC);
