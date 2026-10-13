CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(user_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_active_project ON memories(user_id, project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_provider_time ON conversations(user_id, provider, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_provider ON sources(user_id, provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_logs(user_id, created_at DESC);
