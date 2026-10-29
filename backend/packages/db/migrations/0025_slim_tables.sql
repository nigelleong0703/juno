-- 0025: fewer tables and indexes (BACKEND §9.2, 2026-10-18 cleanup).
--
-- 1. Tables no code reads or writes: memory_facts, memory_snapshots (unused since 2026-10-10), routine_runs (never
--    written), wake_events (wake dedupe lives in the Session state). `memories` was read only by the one-time
--    move into MEMORY.md (marker `__migrations/memories-v1`); that code is gone, so a database that still has
--    unmoved rows stops here instead of losing them.
-- 2. The `search` column and its GIN full-text index on every document table: no query ever used them (list search
--    is gone from the Store), and every write paid for the JSON copy.
-- 3. Indexes: every per-column index on the document tables goes; each document table keeps its primary key plus
--    (owner_id, id) for owner-scoped pages, and the large tables get exactly the filters their queries use.

DROP TABLE IF EXISTS memory_facts, memory_snapshots, routine_runs, wake_events;

DO $$
BEGIN
  IF to_regclass('memories') IS NOT NULL
     AND EXISTS (SELECT 1 FROM memories)
     AND NOT EXISTS (SELECT 1 FROM agent_home WHERE id = 'system:__migrations/memories-v1') THEN
    RAISE EXCEPTION 'memories has rows that were never moved into MEMORY.md: run agentd from a release before 0025 once, then migrate again';
  END IF;
END $$;
DROP TABLE IF EXISTS memories;

DO $$
DECLARE
  r record;
BEGIN
  -- Every non-unique index on a document table (a table with a `doc` column).
  FOR r IN
    SELECT i.indexrelid::regclass AS index_name
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND NOT i.indisprimary AND NOT i.indisunique
      AND EXISTS (SELECT 1 FROM information_schema.columns c
                  WHERE c.table_schema = n.nspname AND c.table_name = t.relname AND c.column_name = 'doc')
  LOOP
    EXECUTE format('DROP INDEX %s', r.index_name);
  END LOOP;

  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'search'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP COLUMN search', r.table_name);
  END LOOP;

  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'doc'
  LOOP
    EXECUTE format('CREATE INDEX %I ON %I (owner_id, id)', 'idx_' || r.table_name || '_owner', r.table_name);
  END LOOP;
END $$;

-- The filters the large tables are queried by (BACKEND §9.1).
CREATE INDEX idx_items_conversation ON items (conversation_id);
CREATE INDEX idx_transcripts_kind ON transcripts (kind);
CREATE INDEX idx_compactions_kind ON compactions (kind);
CREATE INDEX idx_runs_conversation ON runs (conversation_id);
CREATE INDEX idx_runs_agent ON runs (agent_id);
CREATE INDEX idx_steps_run ON steps (run_id);
CREATE INDEX idx_requests_run ON requests (run_id);
CREATE INDEX idx_requests_conversation ON requests (conversation_id);
CREATE INDEX idx_library_conversation ON library (conversation_id);

-- Events are read by owner after an id (SSE replay) and pruned by age.
DROP INDEX IF EXISTS idx_events_owner_id;
CREATE INDEX idx_events_owner ON events (owner_id, id);
CREATE INDEX idx_events_created ON events (created_at);
