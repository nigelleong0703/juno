-- 0067: the tool-list ledger of a connection (doc.toolReview, BACKEND 10.18.3) now hashes a tool's input schema as well as its annotations.
-- A ledger written under the old hash would flag every tool of every connected app as changed, so the old ledgers are dropped: the next
-- tool listing writes a fresh baseline, and a tool is new or changed only against that. Safe to repeat (nothing is left to drop).

UPDATE connections
SET doc = doc - 'toolReview', updated_at = NOW()
WHERE doc ? 'toolReview';
