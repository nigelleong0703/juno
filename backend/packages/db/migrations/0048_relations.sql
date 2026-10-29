-- 0048: relations between people (BACKEND §9.6, batch 7; app/reports/memory-graph-tech-design.md row 10). A row says "person_a is <kind>
-- of person_b". The chat digest states them from quotes, and the code writes them after checking the quote and resolving both names;
-- a closed relation keeps its row (valid_to set) so the history of who managed whom stays readable. Owner-scoped; both ends are composite
-- (id, owner_id) references, so a relation can never name another owner's person. Relations are knowledge only: nothing grants a permission on them.
-- person_a / person_b have no ON DELETE clause on purpose: a person that still has a relation cannot be deleted (linkAccount keeps it).

CREATE TABLE relations (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  person_a text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manager_of', 'colleague', 'client_of', 'works_at', 'spouse', 'parent_of', 'sibling', 'friend', 'other')),
  person_b text NOT NULL,
  kind_label text,
  valid_from timestamptz NOT NULL DEFAULT NOW(),
  valid_to timestamptz,
  evidence jsonb,
  said_by_person_id text,
  said_by_account_id text,
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, owner_id),
  CHECK (person_a <> person_b),
  FOREIGN KEY (person_a, owner_id) REFERENCES people (id, owner_id),
  FOREIGN KEY (person_b, owner_id) REFERENCES people (id, owner_id),
  FOREIGN KEY (said_by_person_id, owner_id) REFERENCES people (id, owner_id) ON DELETE SET NULL (said_by_person_id),
  FOREIGN KEY (said_by_account_id, owner_id) REFERENCES accounts (id, owner_id) ON DELETE SET NULL (said_by_account_id)
);
CREATE INDEX idx_relations_owner_a ON relations (owner_id, person_a, valid_to);
CREATE INDEX idx_relations_owner_b ON relations (owner_id, person_b, valid_to);
-- One open row per statement: the same kind between the same two people is held once (closed rows do not count).
CREATE UNIQUE INDEX idx_relations_open_statement ON relations (owner_id, kind, person_a, person_b) WHERE valid_to IS NULL;
