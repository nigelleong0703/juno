-- 0071: the wake kind `child_task` is now `subagent_task` (owner 2026-11-01: one name, "subagent", everywhere).
-- Rewrites the stored JSON value wherever a wake or a run origin carries it: run origins (`origin` / `rootOrigin.wakeKind`),
-- step rows, transcript rows, the event log and the durable runner's invocation inputs (queued or replayable wakes).
-- Only the exact JSON string "child_task" matches: inside a text value the quotes are escaped (\"child_task\"), so prose is untouched.
-- Harness package snapshots (`harness_versions.files`) keep their historic text; pinned sessions upgrade by unit id (BACKEND 11.2).
UPDATE runs SET doc = replace(doc::text, '"child_task"', '"subagent_task"')::jsonb WHERE doc::text LIKE '%"child_task"%';
UPDATE steps SET doc = replace(doc::text, '"child_task"', '"subagent_task"')::jsonb WHERE doc::text LIKE '%"child_task"%';
UPDATE transcripts SET doc = replace(doc::text, '"child_task"', '"subagent_task"')::jsonb WHERE doc::text LIKE '%"child_task"%';
UPDATE events SET payload = replace(payload::text, '"child_task"', '"subagent_task"')::jsonb WHERE payload::text LIKE '%"child_task"%';
UPDATE audit SET doc = replace(doc::text, '"child_task"', '"subagent_task"')::jsonb WHERE doc::text LIKE '%"child_task"%';
UPDATE invocations SET input = replace(input, '"child_task"', '"subagent_task"') WHERE input LIKE '%"child_task"%';
