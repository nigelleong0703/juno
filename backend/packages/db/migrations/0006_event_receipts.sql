-- Durable event-consumption receipts for webhook redelivery dedupe (LOOP-EVENT1).
-- Additive only: new table + indexes, no changes to existing tables.
-- Written in the same transaction that deletes the consumed subscription, so a retry
-- arriving after the subscription is gone is acknowledged as a duplicate instead of
-- falling back to a brand-new Run. Owner/agent/chat scoped; the id is deterministic
-- over owner/agent/conversation/source/event id.
CREATE TABLE IF NOT EXISTS event_receipts (
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

CREATE INDEX IF NOT EXISTS idx_event_receipts_owner_id ON event_receipts(owner_id);
CREATE INDEX IF NOT EXISTS idx_event_receipts_agent_id ON event_receipts(agent_id);
CREATE INDEX IF NOT EXISTS idx_event_receipts_conversation_id ON event_receipts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_event_receipts_run_id ON event_receipts(run_id);
CREATE INDEX IF NOT EXISTS idx_event_receipts_at ON event_receipts(at DESC);
