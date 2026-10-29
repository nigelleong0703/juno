-- 0059: state that the coordinator writes and execution workers read (BACKEND 2.2c), as ordinary document tables.
--   owner_presence  one row per owner: which apps hold an event stream, who watches which screen, the iPhone's declaration; a heartbeat keeps it alive
--   phone_calls     one row per iPhone call: the worker that asked waits for the app's answer, which the coordinator writes
--   voice_calls     one row per Discord voice tool call: the worker that asked waits for the coordinator that holds the gateway to answer
-- Additive only. Rows are short-lived; the coordinator's heartbeat deletes expired ones.
CREATE TABLE IF NOT EXISTS owner_presence (
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
CREATE INDEX IF NOT EXISTS idx_owner_presence_owner_id ON owner_presence(owner_id);

CREATE TABLE IF NOT EXISTS phone_calls (
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
CREATE INDEX IF NOT EXISTS idx_phone_calls_owner_status ON phone_calls(owner_id, status);

CREATE TABLE IF NOT EXISTS voice_calls (
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
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status, at);
