-- 0058: one control row per surface (a screen, or the owner's Mac): who may act on it right now (BACKEND 7.8b).
-- A screen no longer stores its controller; this moves the user-held screens into the new table once and strips the old
-- fields, so there is one source and no reader falls back to the screen row. Safe to repeat.
CREATE TABLE IF NOT EXISTS controls (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_controls_owner_id ON controls(owner_id);
CREATE INDEX IF NOT EXISTS idx_controls_agent_id ON controls(agent_id);
CREATE INDEX IF NOT EXISTS idx_controls_status ON controls(status);

INSERT INTO controls (id, owner_id, agent_id, status, kind, at, doc)
SELECT
  'screen:' || s.id, s.owner_id, s.doc->>'agentId', 'user', 'screen',
  COALESCE((s.doc->>'controllerSince')::timestamptz, NOW()),
  jsonb_strip_nulls(jsonb_build_object(
    'id', 'screen:' || s.id,
    'ownerId', s.owner_id,
    'surface', jsonb_build_object('kind', 'screen', 'screenId', s.id),
    'agentId', s.doc->>'agentId',
    'holder', 'user',
    'epoch', 1,
    'since', COALESCE(s.doc->>'controllerSince', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'blockedAt', s.doc->'takeover'->>'blockedAt',
    'resumeSnapshotRequired', false,
    'before', (s.doc->'takeover') - 'blockedAt',
    'capabilities', jsonb_build_object('take', true, 'stop', false, 'resumeRemote', true)
  ))
FROM screens s
WHERE s.doc->>'controller' = 'user'
ON CONFLICT (id) DO NOTHING;

UPDATE screens SET doc = doc - 'controller' - 'controllerSince' - 'takeover', updated_at = NOW()
WHERE doc ? 'controller' OR doc ? 'controllerSince' OR doc ? 'takeover';
