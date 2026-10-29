-- 0060: routine runs from before contract 0.68.0 never stored the routine that started them (`Run.routineId`), so the task list
-- (BACKEND 6.5) could not show them. A routine keeps its last 20 run records, and each names its run (`routines.doc.runs[].runId`),
-- so every run still on a routine's list is attributed; older runs fell off the list and cannot be derived (they stay plain runs).
-- Safe to repeat: every UPDATE skips a run that has the field.

WITH named AS (
  SELECT DISTINCT ON (e->>'runId') e->>'runId' AS run_id, rt.id AS routine_id, rt.owner_id, e->>'startedAt' AS started_at
  FROM routines rt, jsonb_array_elements(COALESCE(rt.doc->'runs', '[]'::jsonb)) AS e
  WHERE e->>'runId' IS NOT NULL
  ORDER BY e->>'runId', e->>'startedAt' DESC
)
UPDATE runs r
SET doc = r.doc || jsonb_build_object(
      'routineId', n.routine_id,
      -- 0056 could only call a routine run a system wake; it is the routine's now.
      'origin', CASE WHEN r.doc->'origin'->>'type' = 'system' THEN jsonb_build_object('type', 'routine', 'routineId', n.routine_id, 'occurrenceAt', COALESCE(n.started_at, r.doc->>'startedAt')) ELSE r.doc->'origin' END),
    updated_at = NOW()
FROM named n
WHERE r.id = n.run_id AND r.owner_id = n.owner_id
  AND r.doc->'routineId' IS NULL AND r.doc->>'parentRunId' IS NULL;

-- Children of those runs carry a copy of the root's origin.
UPDATE runs c
SET doc = c.doc || jsonb_build_object('rootOrigin', p.doc->'origin'), updated_at = NOW()
FROM runs p
WHERE p.doc->'routineId' IS NOT NULL AND p.doc->'origin'->>'type' = 'routine'
  AND c.owner_id = p.owner_id AND c.doc->>'rootRunId' = p.id
  AND c.doc->'rootOrigin'->>'type' = 'system';
