-- 0049: skills are versioned (memory-graph design §7, batch 8 part 1). A skill definition (`skill_defs`) keeps its id for life; every content
-- change is a new immutable `skill_versions` row, and `skill_defs.active_version_id` is the pointer the runtime loads. Activating or rolling
-- back moves the pointer; a version's text, name and declared deps never change. The counters (used / helpful / harmful) and the status are
-- the only mutable columns, and `deps[].schemaHash` is set once (pinned on first sight, see memory-graph/src/skills).
-- Legacy `skills` rows are COPIED, not moved: the old table stays for a rollback of this deploy and is no longer read. The copied skill keeps
-- the old id, so an agent's `skillIds` still point at it, and its single version becomes the active one.
-- Owner-scoped like every table; the composite (id, owner_id) keys stop a version or a pointer from naming another owner's skill.

CREATE TABLE skill_defs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('agent', 'owner')),
  agent_id text,
  slug text NOT NULL,
  active_version_id text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, owner_id),
  CHECK ((scope = 'agent') = (agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_skill_defs_owner_slug ON skill_defs (owner_id, slug) WHERE scope = 'owner';
CREATE UNIQUE INDEX idx_skill_defs_agent_slug ON skill_defs (owner_id, agent_id, slug) WHERE scope = 'agent';

CREATE TABLE skill_versions (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  skill_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('candidate', 'active', 'review', 'retired')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL,
  deps jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin text NOT NULL CHECK (origin IN ('manual', 'taught', 'learned', 'installed')),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  helpful integer NOT NULL DEFAULT 0 CHECK (helpful >= 0),
  harmful integer NOT NULL DEFAULT 0 CHECK (harmful >= 0),
  last_used_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, owner_id),
  UNIQUE (skill_id, version),
  FOREIGN KEY (skill_id, owner_id) REFERENCES skill_defs (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX idx_skill_versions_owner_skill ON skill_versions (owner_id, skill_id, version);

-- Copy every legacy row (personal skills; team skills were never created): the definition first, then its version 1, then the pointer.
-- The pointer foreign key comes last, because the two tables reference each other. Agent selections keep the same ids.
INSERT INTO skill_defs (id, owner_id, scope, agent_id, slug, active_version_id, created_at)
SELECT id, owner_id, 'owner', NULL, id, NULL, COALESCE(created_at, NOW())
FROM skills
WHERE COALESCE(doc->>'owner', 'personal') = 'personal';

INSERT INTO skill_versions (id, owner_id, skill_id, version, status, name, description, instructions, deps, origin, used, helpful, harmful, created_by, created_at)
SELECT 'skv-' || id, owner_id, id, 1, 'active', COALESCE(NULLIF(doc->>'name', ''), id), COALESCE(doc->>'description', ''), COALESCE(doc->>'instructions', ''),
       '[]'::jsonb, 'manual', CASE WHEN doc->>'usedCount' ~ '^[0-9]+$' THEN (doc->>'usedCount')::integer ELSE 0 END, 0, 0, owner_id, COALESCE(created_at, NOW())
FROM skills
WHERE COALESCE(doc->>'owner', 'personal') = 'personal';

UPDATE skill_defs SET active_version_id = 'skv-' || id
WHERE id IN (SELECT id FROM skills WHERE COALESCE(doc->>'owner', 'personal') = 'personal');

-- A cleared version (an erased owner's rows, deleted children first) nulls the pointer rather than blocking the delete.
ALTER TABLE skill_defs
  ADD CONSTRAINT skill_defs_active_version_fk FOREIGN KEY (active_version_id, owner_id) REFERENCES skill_versions (id, owner_id) ON DELETE SET NULL (active_version_id);
