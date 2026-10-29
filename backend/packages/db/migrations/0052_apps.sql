-- 0052: Apps (BACKEND §10.18). Two document tables, same shape as every other one.
--
-- agent_apps: what each agent may do with each work or custom app. One row per agent and app, written only when the owner changes the
-- default (enabled, actions ask first). `agent_id` is indexed, the doc holds appId / enabled / actionsPolicy.
-- Installations are not a table: an account or workspace is the row that already holds its credentials (connections,
-- channel_installations, channels), and the Apps view reads them where they are.
--
-- app_catalog: the apps the deployment offers, as data. Deployment-wide, so every row belongs to the `system` owner. The first boot seeds it
-- from the built-in connectors and the chat platform plugins (agentd/src/apps/seed.ts); after that this table is the source of truth for
-- what the Apps page lists and what agents can use, and the admin API edits it. `status` is listed / hidden / retired.

CREATE TABLE IF NOT EXISTS agent_apps (
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

CREATE INDEX IF NOT EXISTS idx_agent_apps_owner_id ON agent_apps(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_apps_agent_id ON agent_apps(agent_id);

CREATE TABLE IF NOT EXISTS app_catalog (
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

CREATE INDEX IF NOT EXISTS idx_app_catalog_owner_id ON app_catalog(owner_id);
