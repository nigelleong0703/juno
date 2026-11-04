-- 0068: earlier versions of files an agent overwrote with files.write / files.edit (BACKEND 5.2d). The bytes are in the blob store (the doc holds only
-- its blobKey), so this table keeps metadata only. Additive: new table, same shape as every collection.
-- parent_id = sha256 of agent, computer and path (one path's history is one indexed read), agent_id / run_id = who overwrote it.
CREATE TABLE IF NOT EXISTS file_snapshots (
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
CREATE INDEX IF NOT EXISTS idx_file_snapshots_owner_id ON file_snapshots(owner_id);
CREATE INDEX IF NOT EXISTS idx_file_snapshots_parent_id ON file_snapshots(parent_id);
CREATE INDEX IF NOT EXISTS idx_file_snapshots_at ON file_snapshots(at DESC);
