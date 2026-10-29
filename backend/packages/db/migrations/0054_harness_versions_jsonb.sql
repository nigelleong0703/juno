-- 0054: harness_versions.files and .evidence were written as a JSON string inside jsonb (`?::jsonb` on JSON.stringify output gives
-- jsonb_typeof = 'string'). The writer now uses `?::text::jsonb`; this turns the rows already written back into the object they hold.
UPDATE harness_versions SET files = (files #>> '{}')::jsonb WHERE jsonb_typeof(files) = 'string';
UPDATE harness_versions SET evidence = (evidence #>> '{}')::jsonb WHERE jsonb_typeof(evidence) = 'string';
