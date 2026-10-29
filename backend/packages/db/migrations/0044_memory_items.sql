-- 0044: memory items, the source of truth for what the agents remember (BACKEND §5.4, §9.5; batch 4). The markdown files
-- (MEMORY.md, memory/bank/*.md, people/<id>.md) are views rendered from the rows of this table. A row is one fact with its
-- labels: who it is about, who said it, where it was said and who may hear it. Owner-scoped like every table; the references to
-- people and accounts are composite (id, owner_id), so a row can never point at another owner's person.

CREATE TABLE memory_items (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  text text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact', 'preference', 'plan', 'relationship', 'role', 'circumstance', 'experience')),
  file text NOT NULL CHECK (file IN ('memory', 'bank:circumstances', 'bank:experiences', 'bank:preferences', 'person')),
  about_person_id text,
  agent_id text,
  said_by_person_id text,
  said_by_account_id text,
  said_by_agent_id text,
  said_in text NOT NULL,
  audience text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted', 'needs_review')),
  claim_id text,
  evidence jsonb,
  legacy_ref text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, legacy_ref),
  UNIQUE (id, owner_id),
  FOREIGN KEY (about_person_id, owner_id) REFERENCES people (id, owner_id) ON DELETE SET NULL (about_person_id),
  FOREIGN KEY (said_by_person_id, owner_id) REFERENCES people (id, owner_id) ON DELETE SET NULL (said_by_person_id),
  FOREIGN KEY (said_by_account_id, owner_id) REFERENCES accounts (id, owner_id) ON DELETE SET NULL (said_by_account_id)
);
CREATE INDEX idx_memory_items_owner_file ON memory_items (owner_id, file, status);
CREATE INDEX idx_memory_items_owner_created ON memory_items (owner_id, created_at);
CREATE INDEX idx_memory_items_claim ON memory_items (owner_id, claim_id);
