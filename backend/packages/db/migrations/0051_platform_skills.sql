-- 0051: platform skills are versioned rows (BACKEND §5.15, M-SELF-EVOLVE). The skills every agent has (pdf, docx, ...) ship as SKILL.md files in
-- the sandbox image (/opt/juno/skills); the server seeds them here at boot, and from then on the text an agent reads comes from these rows.
-- The image files stay the seed only: a changed file becomes a new `seed` version. A `learned` version is made only by the skill patch
-- API (line operations, never a whole rewrite) and starts as a canary candidate next to the active one.
-- No owner data and no owner_id: these tables are the platform's, shared by every agent, so they are not in OWNER_TABLES.
-- Owner skills (0049) are untouched.

CREATE TABLE platform_skills (
  -- The directory name in the image, e.g. 'pdf'.
  id text PRIMARY KEY,
  name text NOT NULL,
  active_version_id text,
  -- sha256 of the image's SKILL.md the newest seed version was made from.
  seed_hash text NOT NULL,
  -- Where the skill comes from, and so when an agent may load it: 'image' (the sandbox image: every agent) or 'app:<appId>' (a skill pack of a
  -- catalog app: only for an agent whose owner added and enabled that app; the check is a predicate the apps module supplies).
  source text NOT NULL DEFAULT 'image' CHECK (source = 'image' OR source LIKE 'app:%'),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE platform_skill_versions (
  id text PRIMARY KEY,
  skill_id text NOT NULL REFERENCES platform_skills (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('candidate', 'active', 'retired')),
  origin text NOT NULL CHECK (origin IN ('seed', 'learned')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL,
  -- The version a learned one was made from, and the line operations (with their evidence run ids) that made it.
  base_version_id text,
  ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Exposure counters: used = runs that read this version; helpful / harmful = nightly outcome labels of those runs.
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  helpful integer NOT NULL DEFAULT 0 CHECK (helpful >= 0),
  harmful integer NOT NULL DEFAULT 0 CHECK (harmful >= 0),
  -- A candidate only: the active version's helpful / harmful when the candidate was made, so the active's rate over the canary window is
  -- (its counters now) - (these).
  base_helpful integer NOT NULL DEFAULT 0,
  base_harmful integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  -- How a candidate ended: promoted | rolled_back | expired | superseded.
  decision text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (skill_id, version)
);
-- One candidate per skill at a time.
CREATE UNIQUE INDEX idx_platform_skill_one_candidate ON platform_skill_versions (skill_id) WHERE status = 'candidate';

-- Operations that were rolled back are not proposed again: op_hash = sha256 over the canonical operation without its evidence.
-- `until` is null for a rollback that the numbers showed was worse (permanent); an expired candidate (not enough data) is blocked for a while only.
CREATE TABLE platform_skill_tombstones (
  skill_id text NOT NULL REFERENCES platform_skills (id) ON DELETE CASCADE,
  op_hash text NOT NULL,
  reason text NOT NULL,
  until timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (skill_id, op_hash)
);
