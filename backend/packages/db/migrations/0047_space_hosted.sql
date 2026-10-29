-- 0047: share links of Spaces on long-lived hosting (BACKEND 5.12, option B). Metadata only: the page files and the data rows live on
-- the hosting service (Cloudflare R2 and D1), never here. One row per Space (id = the Space's id); `doc` is the SpaceHostedRecord
-- (link id, URL, visibility, published version, revoked_at). Same shape as every collection (see 0019_spaces).
CREATE TABLE IF NOT EXISTS space_hosted (
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
CREATE INDEX IF NOT EXISTS idx_space_hosted_owner_id ON space_hosted(owner_id);
