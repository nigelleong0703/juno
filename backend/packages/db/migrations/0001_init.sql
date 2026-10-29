-- Initial database schema: events table and document collections

-- Create events table (SSE log, bigserial ID for ordering)
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_owner_id ON events(owner_id, created_at DESC);

-- For each collection: one table with standard columns
-- Doc structure: {id, owner_id, ...collection-specific fields...}
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON workspaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_agent_id ON workspaces(agent_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_conversation_id ON workspaces(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_run_id ON workspaces(run_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind);
CREATE INDEX IF NOT EXISTS idx_workspaces_parent_id ON workspaces(parent_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_search ON workspaces USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_workspaces_at ON workspaces(at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_owner_id ON agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_agents_agent_id ON agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_conversation_id ON agents(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agents_run_id ON agents(run_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_kind ON agents(kind);
CREATE INDEX IF NOT EXISTS idx_agents_parent_id ON agents(parent_id);
CREATE INDEX IF NOT EXISTS idx_agents_search ON agents USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_agents_at ON agents(at DESC);

CREATE TABLE IF NOT EXISTS computers (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_computers_owner_id ON computers(owner_id);
CREATE INDEX IF NOT EXISTS idx_computers_agent_id ON computers(agent_id);
CREATE INDEX IF NOT EXISTS idx_computers_conversation_id ON computers(conversation_id);
CREATE INDEX IF NOT EXISTS idx_computers_run_id ON computers(run_id);
CREATE INDEX IF NOT EXISTS idx_computers_status ON computers(status);
CREATE INDEX IF NOT EXISTS idx_computers_kind ON computers(kind);
CREATE INDEX IF NOT EXISTS idx_computers_parent_id ON computers(parent_id);
CREATE INDEX IF NOT EXISTS idx_computers_search ON computers USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_computers_at ON computers(at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner_id ON conversations(owner_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_conversation_id ON conversations(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_run_id ON conversations(run_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_kind ON conversations(kind);
CREATE INDEX IF NOT EXISTS idx_conversations_parent_id ON conversations(parent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_search ON conversations USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_conversations_at ON conversations(at DESC);

CREATE TABLE IF NOT EXISTS items (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_owner_id ON items(owner_id);
CREATE INDEX IF NOT EXISTS idx_items_agent_id ON items(agent_id);
CREATE INDEX IF NOT EXISTS idx_items_conversation_id ON items(conversation_id);
CREATE INDEX IF NOT EXISTS idx_items_run_id ON items(run_id);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_parent_id ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_search ON items USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_items_at ON items(at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_owner_id ON runs(owner_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent_id ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_conversation_id ON runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_runs_run_id ON runs(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs(kind);
CREATE INDEX IF NOT EXISTS idx_runs_parent_id ON runs(parent_id);
CREATE INDEX IF NOT EXISTS idx_runs_search ON runs USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_runs_at ON runs(at DESC);

CREATE TABLE IF NOT EXISTS steps (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_steps_owner_id ON steps(owner_id);
CREATE INDEX IF NOT EXISTS idx_steps_agent_id ON steps(agent_id);
CREATE INDEX IF NOT EXISTS idx_steps_conversation_id ON steps(conversation_id);
CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);
CREATE INDEX IF NOT EXISTS idx_steps_kind ON steps(kind);
CREATE INDEX IF NOT EXISTS idx_steps_parent_id ON steps(parent_id);
CREATE INDEX IF NOT EXISTS idx_steps_search ON steps USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_steps_at ON steps(at DESC);

CREATE TABLE IF NOT EXISTS requests (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requests_owner_id ON requests(owner_id);
CREATE INDEX IF NOT EXISTS idx_requests_agent_id ON requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_requests_conversation_id ON requests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_requests_run_id ON requests(run_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_kind ON requests(kind);
CREATE INDEX IF NOT EXISTS idx_requests_parent_id ON requests(parent_id);
CREATE INDEX IF NOT EXISTS idx_requests_search ON requests USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at DESC);

CREATE TABLE IF NOT EXISTS routines (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routines_owner_id ON routines(owner_id);
CREATE INDEX IF NOT EXISTS idx_routines_agent_id ON routines(agent_id);
CREATE INDEX IF NOT EXISTS idx_routines_conversation_id ON routines(conversation_id);
CREATE INDEX IF NOT EXISTS idx_routines_run_id ON routines(run_id);
CREATE INDEX IF NOT EXISTS idx_routines_status ON routines(status);
CREATE INDEX IF NOT EXISTS idx_routines_kind ON routines(kind);
CREATE INDEX IF NOT EXISTS idx_routines_parent_id ON routines(parent_id);
CREATE INDEX IF NOT EXISTS idx_routines_search ON routines USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_routines_at ON routines(at DESC);

CREATE TABLE IF NOT EXISTS routine_runs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_owner_id ON routine_runs(owner_id);
CREATE INDEX IF NOT EXISTS idx_routine_runs_agent_id ON routine_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_routine_runs_conversation_id ON routine_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_routine_runs_run_id ON routine_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_routine_runs_status ON routine_runs(status);
CREATE INDEX IF NOT EXISTS idx_routine_runs_kind ON routine_runs(kind);
CREATE INDEX IF NOT EXISTS idx_routine_runs_parent_id ON routine_runs(parent_id);
CREATE INDEX IF NOT EXISTS idx_routine_runs_search ON routine_runs USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_routine_runs_at ON routine_runs(at DESC);

CREATE TABLE IF NOT EXISTS rules (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rules_owner_id ON rules(owner_id);
CREATE INDEX IF NOT EXISTS idx_rules_agent_id ON rules(agent_id);
CREATE INDEX IF NOT EXISTS idx_rules_conversation_id ON rules(conversation_id);
CREATE INDEX IF NOT EXISTS idx_rules_run_id ON rules(run_id);
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_kind ON rules(kind);
CREATE INDEX IF NOT EXISTS idx_rules_parent_id ON rules(parent_id);
CREATE INDEX IF NOT EXISTS idx_rules_search ON rules USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_rules_at ON rules(at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_owner_id ON audit(owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_conversation_id ON audit(conversation_id);
CREATE INDEX IF NOT EXISTS idx_audit_run_id ON audit(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit(status);
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit(kind);
CREATE INDEX IF NOT EXISTS idx_audit_parent_id ON audit(parent_id);
CREATE INDEX IF NOT EXISTS idx_audit_search ON audit USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_owner_id ON memories(owner_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_conversation_id ON memories(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_run_id ON memories(run_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_parent_id ON memories(parent_id);
CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_memories_at ON memories(at DESC);

CREATE TABLE IF NOT EXISTS skills (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skills_owner_id ON skills(owner_id);
CREATE INDEX IF NOT EXISTS idx_skills_agent_id ON skills(agent_id);
CREATE INDEX IF NOT EXISTS idx_skills_conversation_id ON skills(conversation_id);
CREATE INDEX IF NOT EXISTS idx_skills_run_id ON skills(run_id);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_kind ON skills(kind);
CREATE INDEX IF NOT EXISTS idx_skills_parent_id ON skills(parent_id);
CREATE INDEX IF NOT EXISTS idx_skills_search ON skills USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_skills_at ON skills(at DESC);

CREATE TABLE IF NOT EXISTS plugins (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugins_owner_id ON plugins(owner_id);
CREATE INDEX IF NOT EXISTS idx_plugins_agent_id ON plugins(agent_id);
CREATE INDEX IF NOT EXISTS idx_plugins_conversation_id ON plugins(conversation_id);
CREATE INDEX IF NOT EXISTS idx_plugins_run_id ON plugins(run_id);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status);
CREATE INDEX IF NOT EXISTS idx_plugins_kind ON plugins(kind);
CREATE INDEX IF NOT EXISTS idx_plugins_parent_id ON plugins(parent_id);
CREATE INDEX IF NOT EXISTS idx_plugins_search ON plugins USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_plugins_at ON plugins(at DESC);

CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connections_owner_id ON connections(owner_id);
CREATE INDEX IF NOT EXISTS idx_connections_agent_id ON connections(agent_id);
CREATE INDEX IF NOT EXISTS idx_connections_conversation_id ON connections(conversation_id);
CREATE INDEX IF NOT EXISTS idx_connections_run_id ON connections(run_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);
CREATE INDEX IF NOT EXISTS idx_connections_kind ON connections(kind);
CREATE INDEX IF NOT EXISTS idx_connections_parent_id ON connections(parent_id);
CREATE INDEX IF NOT EXISTS idx_connections_search ON connections USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_connections_at ON connections(at DESC);

CREATE TABLE IF NOT EXISTS library (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_library_owner_id ON library(owner_id);
CREATE INDEX IF NOT EXISTS idx_library_agent_id ON library(agent_id);
CREATE INDEX IF NOT EXISTS idx_library_conversation_id ON library(conversation_id);
CREATE INDEX IF NOT EXISTS idx_library_run_id ON library(run_id);
CREATE INDEX IF NOT EXISTS idx_library_status ON library(status);
CREATE INDEX IF NOT EXISTS idx_library_kind ON library(kind);
CREATE INDEX IF NOT EXISTS idx_library_parent_id ON library(parent_id);
CREATE INDEX IF NOT EXISTS idx_library_search ON library USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_library_at ON library(at DESC);

CREATE TABLE IF NOT EXISTS wake_events (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wake_events_owner_id ON wake_events(owner_id);
CREATE INDEX IF NOT EXISTS idx_wake_events_agent_id ON wake_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_wake_events_conversation_id ON wake_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_wake_events_run_id ON wake_events(run_id);
CREATE INDEX IF NOT EXISTS idx_wake_events_status ON wake_events(status);
CREATE INDEX IF NOT EXISTS idx_wake_events_kind ON wake_events(kind);
CREATE INDEX IF NOT EXISTS idx_wake_events_parent_id ON wake_events(parent_id);
CREATE INDEX IF NOT EXISTS idx_wake_events_search ON wake_events USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_wake_events_at ON wake_events(at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_owner_id ON subscriptions(owner_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_agent_id ON subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_conversation_id ON subscriptions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_run_id ON subscriptions(run_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_kind ON subscriptions(kind);
CREATE INDEX IF NOT EXISTS idx_subscriptions_parent_id ON subscriptions(parent_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_search ON subscriptions USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_subscriptions_at ON subscriptions(at DESC);

CREATE TABLE IF NOT EXISTS memory_facts (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_owner_id ON memory_facts(owner_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_agent_id ON memory_facts(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_conversation_id ON memory_facts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_run_id ON memory_facts(run_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(status);
CREATE INDEX IF NOT EXISTS idx_memory_facts_kind ON memory_facts(kind);
CREATE INDEX IF NOT EXISTS idx_memory_facts_parent_id ON memory_facts(parent_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_search ON memory_facts USING GIN (to_tsvector('english', search));
CREATE INDEX IF NOT EXISTS idx_memory_facts_at ON memory_facts(at DESC);

CREATE TABLE IF NOT EXISTS memory_snapshots (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_owner_id ON memory_snapshots(owner_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_agent_id ON memory_snapshots(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_conversation_id ON memory_snapshots(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_run_id ON memory_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_status ON memory_snapshots(status);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_kind ON memory_snapshots(kind);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_parent_id ON memory_snapshots(parent_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_at ON memory_snapshots(at DESC);

CREATE TABLE IF NOT EXISTS compactions (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compactions_owner_id ON compactions(owner_id);
CREATE INDEX IF NOT EXISTS idx_compactions_agent_id ON compactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_compactions_conversation_id ON compactions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_compactions_run_id ON compactions(run_id);
CREATE INDEX IF NOT EXISTS idx_compactions_status ON compactions(status);
CREATE INDEX IF NOT EXISTS idx_compactions_kind ON compactions(kind);
CREATE INDEX IF NOT EXISTS idx_compactions_parent_id ON compactions(parent_id);
CREATE INDEX IF NOT EXISTS idx_compactions_at ON compactions(at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text,
  conversation_id text,
  run_id text,
  status text,
  kind text,
  parent_id text,
  at timestamptz,
  search text,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_owner_id ON transcripts(owner_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_agent_id ON transcripts(agent_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_conversation_id ON transcripts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_run_id ON transcripts(run_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_status ON transcripts(status);
CREATE INDEX IF NOT EXISTS idx_transcripts_kind ON transcripts(kind);
CREATE INDEX IF NOT EXISTS idx_transcripts_parent_id ON transcripts(parent_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_at ON transcripts(at DESC);
