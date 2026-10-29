-- 0062: the claim query (DurableStore.claim) and the next-due query read only the few rows that are waiting or running, but the
-- table also holds a week of finished invocations (retention is 7 days), so a worker that polls or wakes on every notification
-- must not touch them. Two partial indexes hold exactly those rows, in the order the queries use:
--   pending  -> by the time it becomes claimable (a delayed start, else its creation)
--   running  -> by the end of its lease (a takeover candidate once it passes)
-- Additive; the older (status, ...) indexes stay for the queries that still use them.
CREATE INDEX IF NOT EXISTS idx_invocations_pending_due ON invocations ((COALESCE(not_before, created_at)), id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_invocations_running_lease ON invocations (lease_expires_at, id) WHERE status = 'running' AND lease_expires_at IS NOT NULL;
