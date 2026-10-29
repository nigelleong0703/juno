-- 0058: document drafts (BACKEND 5.11a). One proposed change to a document (a library row with render 'doc'); the Markdown body is in the
-- blob store (the doc holds only its blobKey), so this table keeps metadata only. Additive: new table, same shape as every collection.
-- parent_id = the document (library row) id, status = pending | approved | declined | superseded, run_id / conversation_id / agent_id = who proposed it.
CREATE TABLE IF NOT EXISTS document_drafts (
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
CREATE INDEX IF NOT EXISTS idx_document_drafts_owner_id ON document_drafts(owner_id);
CREATE INDEX IF NOT EXISTS idx_document_drafts_parent_id ON document_drafts(parent_id);
CREATE INDEX IF NOT EXISTS idx_document_drafts_at ON document_drafts(at DESC);
