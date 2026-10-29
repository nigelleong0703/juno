-- 0043: the identity graph, slimmed to two tables (app/reports/memory-graph-tech-design.md, audit 2026-10-25). 0042's seven tables
-- were empty in every database, so the five that are no longer wanted go, and people / accounts are rebuilt in their final shape.
-- Merges and splits are gone: an account is moved with a plain update, and a person left with no accounts (not the owner) is deleted.

DROP TABLE IF EXISTS identity_suggestions;
DROP TABLE IF EXISTS person_events;
DROP TABLE IF EXISTS chat_space_members;
DROP TABLE IF EXISTS chat_spaces;
DROP TABLE IF EXISTS person_aliases;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS people;

-- A person is someone the owner's agents deal with. One row per owner has is_owner = true (the owner themself).
CREATE TABLE people (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  is_owner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, owner_id)
);
CREATE UNIQUE INDEX idx_people_one_owner ON people (owner_id) WHERE is_owner;

-- An account is one identity on one platform. workspace is the Slack team, the Discord guild or the Feishu tenant ('' when the
-- platform has none). An account has at most one person; person_id is NULL until a person is made for it (a DM sender, or a group
-- sender who addresses the agent, or a person_link), so people who only appear in a group are recorded as accounts only.
CREATE TABLE accounts (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('telegram', 'slack', 'discord', 'feishu', 'email', 'meet', 'app')),
  workspace text NOT NULL DEFAULT '',
  external_id text NOT NULL,
  name text,
  person_id text,
  first_seen timestamptz NOT NULL DEFAULT NOW(),
  last_seen timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, platform, workspace, external_id),
  UNIQUE (id, owner_id),
  FOREIGN KEY (person_id, owner_id) REFERENCES people (id, owner_id)
);
CREATE INDEX idx_accounts_person ON accounts (owner_id, person_id);
