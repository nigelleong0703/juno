-- 0068: delivery split (BACKEND 3.3b). Two internal run fields change name and meaning, once, with no read-side fallback:
--   quietEligible (the run was started by a wake nobody waits on) -> nobodyWaiting, same value;
--   quietReason (the one line a finish_quietly call left, which the task list showed as "Nothing to report: <reason>") -> record, the
--   one-line final text of a run nobody waits on; the old line keeps the text the task list showed.
-- Safe to repeat: a run without the old fields is skipped.

UPDATE runs
SET doc = (doc - 'quietEligible' - 'quietReason')
          || CASE WHEN doc ? 'quietEligible' THEN jsonb_build_object('nobodyWaiting', doc->'quietEligible') ELSE '{}'::jsonb END
          || CASE WHEN doc ? 'quietReason' THEN jsonb_build_object('record', 'Nothing to report: ' || (doc->>'quietReason')) ELSE '{}'::jsonb END,
    updated_at = NOW()
WHERE doc ? 'quietEligible' OR doc ? 'quietReason';
