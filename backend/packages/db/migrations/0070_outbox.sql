-- 0070: the outbox (BACKEND 5.7.11). Every delivery to a platform chat or a phone is one row here, retried until it is sent or given up on, so a restart or a
-- failed send no longer loses it. Additive: two new tables of the usual document shape (outbox_control holds the owner's freeze switch).
-- conversation_id = the chat's conversation (ordering is per conversation), status = pending | sent | dropped, kind = the destination kind, at = the source's own time.
CREATE TABLE IF NOT EXISTS outbox (
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
CREATE INDEX IF NOT EXISTS idx_outbox_owner_id ON outbox(owner_id);
CREATE INDEX IF NOT EXISTS idx_outbox_conversation_id ON outbox(conversation_id);
-- The sender's one hot read: the pending rows, oldest first (a small partial index; sent rows are the vast majority).
-- (The expression is the one the store sorts by, so the index serves the query.)
CREATE INDEX IF NOT EXISTS idx_outbox_pending_at ON outbox ((COALESCE(at, '-infinity'::timestamptz)), id) WHERE status = 'pending';
-- Pruning reads the oldest sent / dropped rows the same way.
CREATE INDEX IF NOT EXISTS idx_outbox_done_at ON outbox ((COALESCE(at, '-infinity'::timestamptz)), id) WHERE status <> 'pending';
-- The owner's list of what was dropped, newest first.
CREATE INDEX IF NOT EXISTS idx_outbox_owner_status_at ON outbox(owner_id, status, at DESC);

CREATE TABLE IF NOT EXISTS outbox_control (
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
CREATE INDEX IF NOT EXISTS idx_outbox_control_owner_id ON outbox_control(owner_id);

-- The old delivery bookkeeping becomes outbox rows once, with no read-side fallback: a `send` receipt is a sent row (so the start-up catch-up never sends that
-- reply again), a `send-failed` receipt with no `send` is a dropped row (it was never retried; `retries_exhausted`, and the agent is not told about old ones),
-- an `output` receipt is a sent document row. The receipts are then deleted. Receipts of other types (`posted`, `discord-sent`, event consumption) stay.
-- Row ids are the ones the code derives: obx:reply:<item>, obx:out:<doc>:<version>.
INSERT INTO outbox (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc, created_at)
SELECT 'obx:reply:' || (r.doc->>'eventId'), r.owner_id, r.agent_id, r.conversation_id, r.run_id,
  CASE WHEN r.doc->>'type' = 'send' THEN 'sent' ELSE 'dropped' END, 'channel_reply', COALESCE(r.at, r.created_at),
  jsonb_strip_nulls(jsonb_build_object(
    'id', 'obx:reply:' || (r.doc->>'eventId'), 'ownerId', r.owner_id, 'conversationId', r.conversation_id, 'agentId', r.agent_id,
    'kind', 'channel_reply', 'sourceId', r.doc->>'eventId', 'destination', jsonb_build_object('type', 'channel'), 'platform', 'unknown',
    'status', CASE WHEN r.doc->>'type' = 'send' THEN 'sent' ELSE 'dropped' END, 'attempts', 1,
    'nextAttemptAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'at', to_char(COALESCE(r.at, r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sentAt', CASE WHEN r.doc->>'type' = 'send' THEN to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'droppedAt', CASE WHEN r.doc->>'type' = 'send' THEN NULL ELSE to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'droppedReason', CASE WHEN r.doc->>'type' = 'send' THEN NULL ELSE 'retries_exhausted' END,
    'agentNotified', true)),
  r.created_at
FROM event_receipts r
WHERE r.doc->>'source' = 'channel' AND r.doc->>'type' IN ('send', 'send-failed')
ORDER BY (r.doc->>'type' = 'send') DESC
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbox (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc, created_at)
SELECT 'obx:out:' || (r.doc->>'eventId'), r.owner_id, r.agent_id, r.conversation_id, r.run_id, 'sent', 'channel_output', COALESCE(r.at, r.created_at),
  jsonb_build_object(
    'id', 'obx:out:' || (r.doc->>'eventId'), 'ownerId', r.owner_id, 'conversationId', r.conversation_id, 'agentId', r.agent_id,
    'kind', 'channel_output', 'sourceId', r.doc->>'eventId', 'destination', jsonb_build_object('type', 'channel'), 'platform', 'unknown',
    'status', 'sent', 'attempts', 1,
    'nextAttemptAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'at', to_char(COALESCE(r.at, r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sentAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'agentNotified', true),
  r.created_at
FROM event_receipts r
WHERE r.doc->>'source' = 'channel' AND r.doc->>'type' = 'output'
ON CONFLICT (id) DO NOTHING;

DELETE FROM event_receipts WHERE doc->>'source' = 'channel' AND doc->>'type' IN ('send', 'send-failed', 'output');
