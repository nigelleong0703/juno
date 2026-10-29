-- 0031: the food diary. Same document-collection shape as every other table; the entry itself
-- (eatenAt, mealType, items, totals, ...) lives in doc, so this is only a new table and its owner index.

CREATE TABLE IF NOT EXISTS meals (
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

CREATE INDEX IF NOT EXISTS idx_meals_owner_id ON meals(owner_id);
