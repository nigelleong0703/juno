-- The hosted Spaces schema (BACKEND 5.12, option B). One row per publication: the link a Space is shared by. Its URL is
-- `<slug>-<id>.<CONTENT_DOMAIN>`, so `id` (the link id) is the unguessable part. Republishing bumps `version` and keeps the
-- URL; revoking sets `revoked_at` and drops the data rows. The page files live in R2 under `<id>/<version>/<path>`.
CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY NOT NULL,
  host TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'link', 'public')),
  version INTEGER NOT NULL CHECK (version >= 1),
  -- 1 = visitors (anyone without the owner's session) may change the data; 0 = they may only read it. The owner always may.
  visitor_writes INTEGER NOT NULL DEFAULT 0 CHECK (visitor_writes IN (0, 1)),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The Space's data, as documents: the table API under /api/<table> reads and writes these. `row_id` is the id the client sees
-- (a number for the Space's integer keys), `body` the JSON of the other fields.
CREATE TABLE IF NOT EXISTS space_rows (
  publication_id TEXT NOT NULL REFERENCES publications(id),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (publication_id, table_name, row_id)
);
