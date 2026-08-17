-- Optional: semantic asset search.
--
-- Requires the pgvector extension. Apply after schema.sql on deployments that
-- want natural-language media search ("show me photos of the team outside").
-- Everything else in the platform works without it; `searchAssets` falls back
-- to tag and text matching when an asset has no embedding.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS embedding vector(512);

CREATE INDEX IF NOT EXISTS assets_embedding_idx
  ON assets USING hnsw (embedding vector_cosine_ops);
