-- 0026: no workspaces (BACKEND §9.2, 2026-10-18).
--
-- Every user had exactly one personal workspace, and every record is already scoped by owner_id, so the workspaces
-- concept is gone: the table (and its indexes) is dropped, and `workspaceId` is stripped from the documents that
-- carried it (agents, conversations, routines, library, skills).

DROP TABLE IF EXISTS workspaces;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'doc'
  LOOP
    EXECUTE format('UPDATE %I SET doc = doc - %L WHERE doc ? %L', r.table_name, 'workspaceId', 'workspaceId');
  END LOOP;
END $$;
