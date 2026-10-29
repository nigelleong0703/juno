-- Devices: push-notification registrations (APNs tokens) per owner. Same document-collection shape as
-- 0009_feed. Additive only: a new table + indexes.

CREATE TABLE IF NOT EXISTS devices (
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

CREATE INDEX IF NOT EXISTS idx_devices_owner_id ON devices(owner_id);
