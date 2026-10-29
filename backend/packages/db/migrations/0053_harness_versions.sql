-- 0053: the harness package's versions (BACKEND §11.2, H1a). The model-facing text of the agent (system prompt sections, note texts, wake
-- and injected texts, background-job prompts) is a set of units; a version is one complete set, written as unit files (id -> file text).
-- The repository seed is the `seed` version made at boot from its hash; a new seed is a new row, never an edit. A session pins the version
-- its frozen system row names (contextMeta.harnessVersion), so its cache prefix never changes. No owner data: the platform's own text.

CREATE TABLE harness_versions (
  -- `hv_` and 12 hex characters of the sha256 over the unit files.
  id text PRIMARY KEY,
  parent_id text REFERENCES harness_versions (id),
  -- unit id -> the unit's file text (frontmatter and body), exactly as the loader parses it.
  files jsonb NOT NULL,
  origin text NOT NULL CHECK (origin IN ('seed', 'admin', 'learned', 'external')),
  status text NOT NULL CHECK (status IN ('candidate', 'active', 'retired')),
  note text NOT NULL DEFAULT '',
  -- Run ids and counts that justified a learned or external version (H2 writes it; empty for a seed).
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
-- At most one active version, and at most one candidate.
CREATE UNIQUE INDEX idx_harness_one_active ON harness_versions ((status)) WHERE status = 'active';
CREATE UNIQUE INDEX idx_harness_one_candidate ON harness_versions ((status)) WHERE status = 'candidate';
