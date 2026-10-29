-- 0057: the task tree (BACKEND 6.5). Child runs, routine runs and background jobs read as one tree of tasks, so the rows carry what the
-- tree needs; this backfills the rows that exist, once, so no reader needs a fallback. Safe to repeat: every UPDATE skips a row that has the field.

-- 1. runs.parent_id was never written (the column was picked from a doc field named `parentId`; child runs store `parentRunId`).
UPDATE runs SET parent_id = doc->>'parentRunId', updated_at = NOW()
WHERE parent_id IS NULL AND doc->>'parentRunId' IS NOT NULL;

-- 2. A routine's runs are listed by the routine that started them.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS routine_id text GENERATED ALWAYS AS (doc->>'routineId') STORED;
CREATE INDEX IF NOT EXISTS idx_runs_routine ON runs(owner_id, routine_id, at DESC) WHERE routine_id IS NOT NULL;

-- 3. rootRunId / depth of every child run (a run that is its own root has neither). A child whose parent is gone starts its own tree.
WITH RECURSIVE tree AS (
  SELECT r.id, r.owner_id, r.id AS root, 0 AS depth
  FROM runs r
  WHERE r.doc->>'parentRunId' IS NULL
     OR NOT EXISTS (SELECT 1 FROM runs p WHERE p.id = r.doc->>'parentRunId' AND p.owner_id = r.owner_id)
  UNION ALL
  SELECT c.id, c.owner_id, t.root, t.depth + 1
  FROM runs c JOIN tree t ON c.doc->>'parentRunId' = t.id AND c.owner_id = t.owner_id
  WHERE t.depth < 16
)
UPDATE runs r
SET doc = r.doc || jsonb_build_object('rootRunId', t.root, 'depth', t.depth), updated_at = NOW()
FROM tree t
WHERE r.id = t.id AND t.depth > 0 AND r.doc->'rootRunId' IS NULL;

-- 4. Why a blocked run is blocked, from the reason text the run wrote. Every other blocked run hit a budget or output limit.
UPDATE runs
SET doc = doc || jsonb_build_object('blockCause',
      CASE
        WHEN doc->>'error' IS NULL OR doc->>'error' LIKE '%need input%' OR doc->>'error' LIKE '%no actionable task state%' THEN 'needs_input'
        WHEN doc->>'error' LIKE '%task state unreadable%' THEN 'unreadable'
        WHEN doc->>'error' LIKE '%completion checks did not pass%' THEN 'verification'
        WHEN doc->>'error' LIKE '%no progress%' THEN 'no_progress'
        ELSE 'limit'
      END),
    updated_at = NOW()
WHERE doc->>'status' = 'blocked' AND doc->'blockCause' IS NULL;

-- 5. effectReview: a run with an uncertain-action card the owner has not settled (pending, or answered "still unknown") is `open`; one whose cards are all settled is `resolved`.
UPDATE runs r
SET doc = r.doc || jsonb_build_object('effectReview',
      CASE WHEN EXISTS (SELECT 1 FROM requests q WHERE q.run_id = r.id AND q.owner_id = r.owner_id
                          AND q.doc->'reconciliation'->>'state' IN ('pending', 'still_unknown'))
           THEN 'open' ELSE 'resolved' END),
    updated_at = NOW()
WHERE r.doc->'effectReview' IS NULL
  AND EXISTS (SELECT 1 FROM requests q WHERE q.run_id = r.id AND q.owner_id = r.owner_id AND q.doc->'reconciliation' IS NOT NULL);

-- 6. Background jobs: the root of the run that started them. A stopped MCP call from before this release has no
-- `stopDelivery` and stays a plain cancellation: flagging every past stop as an unknown effect would only be noise.
UPDATE background_tasks b
SET doc = b.doc || jsonb_build_object('rootRunId', COALESCE(r.doc->>'rootRunId', r.id)), updated_at = NOW()
FROM runs r
WHERE r.id = b.doc->>'runId' AND r.owner_id = b.owner_id AND b.doc->'rootRunId' IS NULL;
