-- DAMC v0.3: retrieval, current-state, and API-key foundations.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content,'')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_search_vector ON memories USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_memories_project_status_updated ON memories(user_id, project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'default',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS current_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_current_states_user ON current_states(user_id);
