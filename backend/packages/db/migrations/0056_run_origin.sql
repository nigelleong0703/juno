-- 0056: runs record what started them (contract 0.68.0 `Run.origin` / `Run.rootOrigin`) and audit rows record who started the
-- work (`AuditEntry.initiator` / `unattended`). New runs and entries get these when they are written; this backfills the rows
-- that exist, once, so no reader needs a fallback. Safe to repeat: every UPDATE skips a row that already has the field.
--
-- Old runs only have `kind`, so the origin is the minimal honest one:
--   chat / manual   -> owner_message in the run's conversation. A chat run in a platform chat cannot be attributed to a speaker any
--                      more (the wake that said who spoke is gone), so it reads as the owner's.
--   routine / scheduled / background -> system, wakeKind 'routine' / 'scheduled' / 'background' (the routine id was never stored).
--   child (parentRunId set) -> parent_run; rootOrigin is the origin of the run at the top of the chain.

-- Root runs.
UPDATE runs
SET doc = jsonb_set(doc, '{origin}',
      CASE
        WHEN doc->>'kind' IN ('chat', 'manual') AND doc->>'conversationId' IS NOT NULL
          THEN jsonb_build_object('type', 'owner_message', 'conversationId', doc->>'conversationId')
        ELSE jsonb_build_object('type', 'system', 'wakeKind', COALESCE(doc->>'kind', 'run'))
      END),
    updated_at = NOW()
WHERE doc->'origin' IS NULL AND doc->>'parentRunId' IS NULL;

-- Child runs, parents first: each pass fills the children whose parent already has an origin, until none is left.
DO $$
DECLARE
  filled integer;
BEGIN
  LOOP
    UPDATE runs c
    SET doc = c.doc || jsonb_build_object(
          'origin', jsonb_build_object('type', 'parent_run', 'runId', c.doc->>'parentRunId'),
          'rootOrigin', COALESCE(p.doc->'rootOrigin', p.doc->'origin')),
        updated_at = NOW()
    FROM runs p
    WHERE c.doc->'origin' IS NULL AND c.doc->>'parentRunId' IS NOT NULL
      AND p.id = c.doc->>'parentRunId' AND p.owner_id = c.owner_id AND p.doc->'origin' IS NOT NULL;
    GET DIAGNOSTICS filled = ROW_COUNT;
    EXIT WHEN filled = 0;
  END LOOP;
END $$;

-- Children whose parent is gone: unattended, like the runtime does for a parent it cannot find.
UPDATE runs
SET doc = doc || jsonb_build_object(
      'origin', jsonb_build_object('type', 'parent_run', 'runId', doc->>'parentRunId'),
      'rootOrigin', jsonb_build_object('type', 'system', 'wakeKind', 'child_task', 'label', 'parent run not found')),
    updated_at = NOW()
WHERE doc->'origin' IS NULL AND doc->>'parentRunId' IS NOT NULL;

-- Audit: the filters read these two generated columns, so a filtered list needs no write-path change.
ALTER TABLE audit ADD COLUMN IF NOT EXISTS initiator text GENERATED ALWAYS AS (doc->'initiator'->>'type') STORED;
ALTER TABLE audit ADD COLUMN IF NOT EXISTS unattended boolean GENERATED ALWAYS AS ((doc->'unattended')::boolean) STORED;
CREATE INDEX IF NOT EXISTS idx_audit_initiator ON audit(owner_id, initiator, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_unattended ON audit(owner_id, at DESC) WHERE unattended;

-- Entries that belong to a run take the run's root origin.
UPDATE audit a
SET doc = a.doc || jsonb_build_object(
      'initiator', COALESCE(r.doc->'rootOrigin', r.doc->'origin'),
      'unattended', NOT (
        COALESCE(r.doc->'rootOrigin', r.doc->'origin')->>'type' = 'owner_message'
        OR (COALESCE(r.doc->'rootOrigin', r.doc->'origin')->>'type' = 'channel' AND COALESCE(r.doc->'rootOrigin', r.doc->'origin')->>'speaker' = 'owner'))),
    updated_at = NOW()
FROM runs r
WHERE a.doc->'initiator' IS NULL AND r.id = a.run_id AND r.owner_id = a.owner_id AND COALESCE(r.doc->'rootOrigin', r.doc->'origin') IS NOT NULL;

-- Entries without a run (or whose run is gone): a system action.
UPDATE audit
SET doc = doc || jsonb_build_object('initiator', jsonb_build_object('type', 'system', 'wakeKind', 'system'), 'unattended', TRUE),
    updated_at = NOW()
WHERE doc->'initiator' IS NULL;
