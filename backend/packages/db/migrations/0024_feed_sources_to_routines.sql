-- Feed sources are gone (BACKEND 10.10): an agent posts to the Feed from its normal work and from its routines. Every
-- feed source becomes a plain routine for the same owner and agent: same schedule, timezone and enabled state, the
-- source's title as the name, its instructions plus one line saying what to do with the result. The source's own hidden
-- routine (`rtn-<source id>`) is that routine, converted in place (so it keeps its run history and timer; no duplicate);
-- one is created only if it is missing. Feed posts lose `sourceId`/`kind` and gain `routineId` where the routine is known.
-- Then the feed_sources table is dropped.

-- 1. The hidden routine of every source becomes a plain one.
UPDATE routines r SET
  doc = (r.doc - 'feedSourceId') || jsonb_build_object(
    'name', s.doc->>'title',
    'instructions', (s.doc->>'instructions') || E'\n\n' || CASE s.doc->>'kind'
      WHEN 'brief' THEN 'Each morning prepare my brief of the day and post it to the Feed if there is something worth seeing.'
      WHEN 'news' THEN 'Find the latest on these topics and post one digest to the Feed if there is something new worth seeing.'
      WHEN 'email' THEN 'Read my unread email and post a short digest of the important messages to the Feed if there is something worth seeing.'
      WHEN 'watch' THEN 'Check this and post to the Feed only if it changed in a way I would care about, saying what changed.'
      ELSE 'Post the result to the Feed if there is something new worth seeing.'
    END,
    'notify', jsonb_build_object('mode', CASE WHEN s.doc->>'notify' = 'true' THEN 'always' ELSE 'never' END)
  ),
  updated_at = NOW()
FROM feed_sources s
WHERE r.id = 'rtn-' || s.id;

-- 2. A source whose routine is missing gets one, built from its schedule (cron in the source's timezone). A source whose agent is gone is dropped with the table.
INSERT INTO routines (id, owner_id, agent_id, status, at, doc)
SELECT 'rtn-' || s.id, s.owner_id, s.doc->>'agentId', 'active', COALESCE((s.doc->>'createdAt')::timestamptz, NOW()),
  jsonb_build_object(
    'id', 'rtn-' || s.id,
    'ownerId', s.owner_id,
    'workspaceId', COALESCE((SELECT a.doc->>'workspaceId' FROM agents a WHERE a.id = s.doc->>'agentId'), ''),
    'agentId', s.doc->>'agentId',
    'name', s.doc->>'title',
    'instructions', (s.doc->>'instructions') || E'\n\n' || CASE s.doc->>'kind'
      WHEN 'brief' THEN 'Each morning prepare my brief of the day and post it to the Feed if there is something worth seeing.'
      WHEN 'news' THEN 'Find the latest on these topics and post one digest to the Feed if there is something new worth seeing.'
      WHEN 'email' THEN 'Read my unread email and post a short digest of the important messages to the Feed if there is something worth seeing.'
      WHEN 'watch' THEN 'Check this and post to the Feed only if it changed in a way I would care about, saying what changed.'
      ELSE 'Post the result to the Feed if there is something new worth seeing.'
    END,
    'trigger', jsonb_build_object(
      'kind', 'schedule',
      'cron', (split_part(s.doc#>>'{schedule,time}', ':', 2)::int)::text || ' ' || (split_part(s.doc#>>'{schedule,time}', ':', 1)::int)::text || ' * * ' ||
        CASE
          WHEN s.doc#>>'{schedule,kind}' = 'weekly' THEN (array_position(ARRAY['sun','mon','tue','wed','thu','fri','sat'], s.doc#>>'{schedule,day}') - 1)::text
          WHEN s.doc#>'{schedule,days}' IS NULL THEN '*'
          ELSE (SELECT string_agg(n::text, ',' ORDER BY n) FROM (SELECT DISTINCT array_position(ARRAY['sun','mon','tue','wed','thu','fri','sat'], d) - 1 AS n FROM jsonb_array_elements_text(s.doc#>'{schedule,days}') d) days)
        END,
      'human', 'Feed schedule at ' || (s.doc#>>'{schedule,time}') || ' (' || COALESCE(s.doc->>'timezone', 'UTC') || ')',
      'tz', COALESCE(s.doc->>'timezone', 'UTC')
    ),
    'delivery', jsonb_build_object('channel', 'chat'),
    'notify', jsonb_build_object('mode', CASE WHEN s.doc->>'notify' = 'true' THEN 'always' ELSE 'never' END),
    'enabled', COALESCE((s.doc->>'enabled')::boolean, true),
    'status', 'active',
    'runs', '[]'::jsonb,
    'createdAt', COALESCE(s.doc->>'createdAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  )
FROM feed_sources s
WHERE NOT EXISTS (SELECT 1 FROM routines r WHERE r.id = 'rtn-' || s.id)
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = s.doc->>'agentId');

-- 3. Posts point at the routine instead of the source, where that routine exists; the indexed `kind` column held the source kind.
UPDATE feed_posts p SET
  doc = (p.doc - 'sourceId' - 'kind') || CASE
    WHEN p.doc ? 'sourceId' AND EXISTS (SELECT 1 FROM routines r WHERE r.id = 'rtn-' || (p.doc->>'sourceId')) THEN jsonb_build_object('routineId', 'rtn-' || (p.doc->>'sourceId'))
    ELSE '{}'::jsonb
  END,
  kind = NULL
WHERE p.doc ? 'sourceId' OR p.doc ? 'kind' OR p.kind IS NOT NULL;

-- 4. The `search` copy of a changed row follows its document.
UPDATE routines SET search = doc::text WHERE id IN (SELECT 'rtn-' || id FROM feed_sources);
UPDATE feed_posts SET search = doc::text WHERE search LIKE '%"sourceId"%';

DROP TABLE feed_sources;
