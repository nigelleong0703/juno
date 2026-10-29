-- The in-process durable runner (packages/durable) replaces Restate: invocations, their step journal,
-- per-key object state and the wait rows (awakeables, cancel). Times are epoch milliseconds; JSON is text.
-- Same shape as migrations-sqlite/0002_durable_runner.sql.
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  key TEXT NOT NULL,
  handler TEXT NOT NULL,
  input TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  not_before BIGINT,
  idempotency_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invocations_idempotency ON invocations(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invocations_status ON invocations(status, not_before);
CREATE INDEX IF NOT EXISTS idx_invocations_target ON invocations(service, key);

CREATE TABLE IF NOT EXISTS journal (
  invocation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  result TEXT,
  error TEXT,
  PRIMARY KEY (invocation_id, seq)
);

CREATE TABLE IF NOT EXISTS objects (
  service TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (service, key)
);

CREATE TABLE IF NOT EXISTS waits (
  id TEXT PRIMARY KEY,
  invocation_id TEXT,
  kind TEXT NOT NULL,
  value TEXT,
  resolved_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waits_invocation ON waits(invocation_id);
