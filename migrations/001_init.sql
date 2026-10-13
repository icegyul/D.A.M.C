CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_type text NOT NULL,
  external_id text,
  title text,
  uri text,
  content_hash text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider, source_type, external_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_id text,
  title text,
  started_at timestamptz,
  ended_at timestamptz,
  raw_payload jsonb,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id text,
  role text NOT NULL,
  content text NOT NULL,
  sequence_no int NOT NULL,
  sent_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, sequence_no),
  UNIQUE(conversation_id, external_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  summary text,
  status text NOT NULL DEFAULT 'candidate',
  importance numeric(4,3) NOT NULL DEFAULT 0.500,
  confidence numeric(4,3) NOT NULL DEFAULT 0.500,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  version int NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  content text NOT NULL,
  status text NOT NULL,
  change_reason text,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(memory_id, version_no)
);

CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0.500,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(from_memory_id, to_memory_id, relation_type)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model text NOT NULL,
  dimensions int NOT NULL,
  vector_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(memory_id, model)
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime_type text,
  content_hash text NOT NULL,
  storage_path text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  memory_id uuid REFERENCES memories(id) ON DELETE SET NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  due_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector text NOT NULL,
  direction text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  cursor text,
  started_at timestamptz,
  finished_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  error_message text,
  stats jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected',
  capability jsonb NOT NULL DEFAULT '{}',
  last_sync_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_project ON memories(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type_status ON memories(user_id, type, status);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(user_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_memory_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_memory_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_user_status ON sync_jobs(user_id, status, created_at);
