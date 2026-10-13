-- DAMC v0.5: make Korean retrieval and conflict detection index-backed.
--
-- PROBLEM 1 — Korean accuracy.
-- memories.search_vector is built with to_tsvector('simple', …). The 'simple'
-- configuration lowercases and splits on non-word characters and does nothing
-- else: no stemming, no morphology. Korean is agglutinative, so the particle
-- fuses to the noun and becomes part of the token — "데이터베이스는" indexes as
-- the single token 데이터베이스는. A search for "데이터베이스" is then not a
-- prefix or a stem of anything in the index and matches nothing, which is why
-- retrieval-service.ts needed a substring fallback for every Korean query.
--
-- PROBLEM 2 — that fallback, and conflict detection, both scan.
-- The fallback (lower(content) LIKE '%…%') and memory-engine.ts's conflict
-- narrowing (content ILIKE '%needle%', up to 8 OR'd patterns) use leading
-- wildcards, which no btree index can serve. Both therefore read every memory
-- row the user owns. Conflict detection runs on every single memory write, so
-- the cost of storing a memory grew with the size of the hub — the wrong shape
-- for something meant to accumulate for years.
--
-- FIX: pg_trgm. Trigram indexes serve exactly the leading-wildcard ILIKE/LIKE
-- patterns both paths already issue, and trigram matching is substring-based, so
-- "데이터베이스" matches "데이터베이스는" without needing a Korean stemmer. The
-- queries keep their current semantics; they stop being sequential scans.
--
-- pg_trgm is a standard contrib module, present in the postgres:17-alpine image
-- docker-compose.yml uses.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gin_trgm_ops serves ILIKE/LIKE '%…%' on these columns. Separate indexes rather
-- than one over a concatenation: the queries filter each column on its own
-- (title OR content OR summary), and the planner can pick or combine them.
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_title_trgm ON memories USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_summary_trgm ON memories USING GIN (summary gin_trgm_ops);

-- Conflict detection narrows by (user_id, type, status) before the ILIKE, and
-- reads only active/confirmed standing memories. A partial index keeps it small:
-- superseded history never participates in conflict detection.
CREATE INDEX IF NOT EXISTS idx_memories_standing_conflict
  ON memories (user_id, type, updated_at DESC)
  WHERE status IN ('active', 'confirmed');
