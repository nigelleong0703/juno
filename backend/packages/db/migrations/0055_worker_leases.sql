-- Multi-worker execution leases: several agentd processes may execute durable invocations against one database.
-- Additive only: existing invocations, journals, objects and waits are untouched. Rows written before this
-- migration have no lease (lease_expires_at IS NULL) and are reclaimed once, exactly like a crashed process.
--
--   epoch             monotonic fencing token; every claim takes the next value of durable_epoch_seq
--   lease_owner       the worker that currently runs the invocation (NULL once done, failed or released)
--   lease_expires_at  database-time deadline in epoch milliseconds; a write after it is rejected
--   invocation_lanes  one row per (service, key): the cross-process object/service lock that keeps the key exclusive
CREATE SEQUENCE IF NOT EXISTS durable_epoch_seq AS BIGINT START WITH 1 INCREMENT BY 1;

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_invocations_lease ON invocations(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS invocation_lanes (
  service TEXT NOT NULL,
  key TEXT NOT NULL,
  owner TEXT,
  epoch BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT,
  PRIMARY KEY (service, key)
);
CREATE INDEX IF NOT EXISTS idx_invocation_lanes_expiry ON invocation_lanes(expires_at);

-- Mixed-version gate. An agentd build without worker leases holds the same whole-process advisory lock and
-- re-queues every `running` row on boot, and old rows have no lease at all. A new worker must therefore never
-- run beside an old coordinator: only the new coordinator (which owns the advisory lock) reclaims the
-- lease-less rows once, then publishes this marker and heartbeats it. A worker refuses to start or keep
-- claiming when the marker is missing, drained or stale; rolling back to an old binary starts with all
-- workers drained, because an old coordinator would otherwise requeue work the workers are still running.
CREATE TABLE IF NOT EXISTS durable_coordination (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  heartbeat_at BIGINT NOT NULL,
  detail TEXT
);
