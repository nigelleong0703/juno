-- Private tool-output artifacts (PH9). Owner/agent scoped; the text never enters the transcript.
CREATE TABLE IF NOT EXISTS artifacts (
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

CREATE INDEX IF NOT EXISTS idx_artifacts_owner_id ON artifacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_agent_id ON artifacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_at ON artifacts(at DESC);
