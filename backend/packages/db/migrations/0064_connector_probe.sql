-- 0059: connectors that take the owner's own key are connected only after a read-only probe call succeeds (BACKEND 10.18.1).
-- A catalog package whose server has auth `api_key` must now name that call (`mcpServers.<name>.probe`), so the one built-in keyed app that
-- was seeded before this (Hevy) gets its probe here, once. Every version of the app is updated (an edit writes a new version row), and a row
-- that already has a probe is left alone, so this is safe to repeat.

UPDATE app_catalog
SET doc = jsonb_set(doc, '{mcpServers,hevy,probe}', '{"tool": "workout_count"}'::jsonb, true), updated_at = NOW()
WHERE doc->>'appId' = 'hevy'
  AND doc #> '{mcpServers,hevy}' IS NOT NULL
  AND doc #> '{mcpServers,hevy,probe}' IS NULL;
