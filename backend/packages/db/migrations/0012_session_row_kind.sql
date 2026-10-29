-- Transcript and compaction rows are read per session on every model step. They carried no indexed
-- column for the session, so each read paged the owner's whole table and filtered in memory.
-- New rows now store their sessionKey in the existing indexed `kind` column (db/src/queries.ts
-- projections); this backfills the rows written before that. Additive: no schema change, only fills
-- NULL values on two tables, and re-running it is a no-op.
UPDATE transcripts SET kind = doc->>'sessionKey' WHERE kind IS NULL AND doc ? 'sessionKey';
UPDATE compactions SET kind = doc->>'sessionKey' WHERE kind IS NULL AND doc ? 'sessionKey';
