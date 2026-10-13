-- DAMC v0.4 integrity fixes and operational metadata.
CREATE UNIQUE INDEX IF NOT EXISTS uq_current_states_user_global
  ON current_states(user_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_current_states_user_project
  ON current_states(user_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence ON messages(conversation_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_memories_user_updated ON memories(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(user_id, from_memory_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(user_id, to_memory_id);
