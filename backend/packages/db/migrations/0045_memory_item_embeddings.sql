-- 0045: vectors on the memory items (BACKEND §5.3, §5.4; batch 5a). An item is embedded after it is written (and backfilled at boot), so
-- memory_search and the memory section can rank the items a presence may see. embed_model names the model that made the vector: a row
-- whose model differs from the current embedder is embedded again. NULL = not embedded yet; search then ranks that item by words only.
-- The old search index (memory_entries, 0017) is no longer read; its rows are left in place.

ALTER TABLE memory_items
  ADD COLUMN embedding jsonb NULL,
  ADD COLUMN embed_model text NULL;
