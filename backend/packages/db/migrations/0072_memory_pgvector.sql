-- 0072: memory vectors in pgvector (BACKEND §5.4). memory_items.embedding was a jsonb number array compared in JS; it becomes
-- vector(n) with an HNSW index (cosine), and search ranks in SQL (ORDER BY embedding <=> q LIMIT k).
--
-- Needs the `vector` extension. Where the database role may create it, this creates it; otherwise a superuser creates it once
-- (CREATE EXTENSION vector) before this runs, and this only checks that it is there. n is the length of the stored vectors (all one model);
-- an empty table gets 1024 (jina-embeddings-v5-text-small). A different model with another length is handled at boot: the column is
-- retyped and the items are embedded again (memory-graph alignEmbeddingDimension). The old jsonb column is replaced, not kept.
DO $$
DECLARE
  dim integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
      RAISE EXCEPTION 'pgvector is not installed on this Postgres server (install the postgresql-18-pgvector package, then CREATE EXTENSION vector as a superuser)';
    END IF;
    CREATE EXTENSION vector;
  END IF;

  SELECT jsonb_array_length(embedding) INTO dim FROM memory_items WHERE jsonb_typeof(embedding) = 'array' ORDER BY created_at, id LIMIT 1;
  dim := COALESCE(dim, 1024);
  -- A vector of another length would not fit the column; it is dropped and embedded again by the backfill.
  UPDATE memory_items SET embedding = NULL, embed_model = NULL
    WHERE embedding IS NOT NULL AND (jsonb_typeof(embedding) <> 'array' OR jsonb_array_length(embedding) <> dim);
  EXECUTE format('ALTER TABLE memory_items ALTER COLUMN embedding TYPE vector(%s) USING embedding::text::vector', dim);
END $$;

CREATE INDEX memory_items_embedding_hnsw ON memory_items USING hnsw (embedding vector_cosine_ops);
