-- 0042: identity graph (memory-graph design §1.1, phase 2.1). People, the accounts they speak from, the spaces (chats, meetings,
-- threads, email threads) those accounts sit in, and an append-only event log that makes merges and splits reversible.
-- Every table has owner_id. The (id, owner_id) keys let the composite foreign keys check the owner in the database too.
-- The space tables are chat_spaces / chat_space_members: `spaces` is the app-Spaces table of 0019.

CREATE TABLE IF NOT EXISTS people (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  display_name text,
  role text NOT NULL CHECK (role IN ('self', 'contact')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'deleted')),
  merged_into text,
  confirmed boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (merged_into, owner_id) REFERENCES people (id, owner_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_one_self ON people (owner_id) WHERE role = 'self';

CREATE TABLE IF NOT EXISTS person_aliases (
  person_id text NOT NULL,
  owner_id text NOT NULL,
  alias text NOT NULL,
  kind text NOT NULL DEFAULT 'nickname' CHECK (kind IN ('nickname', 'former_name')),
  PRIMARY KEY (person_id, alias),
  FOREIGN KEY (person_id, owner_id) REFERENCES people (id, owner_id)
);

CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('app', 'telegram', 'slack', 'discord', 'feishu', 'email', 'meet', 'phone')),
  workspace_id text NOT NULL DEFAULT '',
  external_id text NOT NULL,
  display_name text,
  handle text,
  person_id text,
  link_state text NOT NULL DEFAULT 'unlinked'
    CHECK (link_state IN ('confirmed_owner', 'platform_verified', 'owner_confirmed', 'agent_proposed', 'unlinked')),
  link_evidence jsonb,
  ephemeral boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT NOW(),
  last_seen timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, kind, workspace_id, external_id),
  UNIQUE (id, owner_id),
  FOREIGN KEY (person_id, owner_id) REFERENCES people (id, owner_id),
  CHECK ((person_id IS NULL) = (link_state = 'unlinked'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_person ON accounts (owner_id, person_id);

CREATE TABLE IF NOT EXISTS identity_suggestions (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('link_account', 'merge_person')),
  a_id text NOT NULL,
  b_id text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_identity_suggestions_owner ON identity_suggestions (owner_id, status);

CREATE TABLE IF NOT EXISTS person_events (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT NOW(),
  actor text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'linked', 'unlinked', 'merged', 'split', 'renamed', 'confirmed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_person_events_owner ON person_events (owner_id, id);

CREATE TABLE IF NOT EXISTS chat_spaces (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dm', 'group', 'channel', 'thread', 'meeting', 'email_thread', 'app_room')),
  platform text NOT NULL,
  workspace_id text NOT NULL DEFAULT '',
  external_key text NOT NULL,
  title text,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'member', 'public')),
  roster_state text NOT NULL DEFAULT 'unknown' CHECK (roster_state IN ('complete', 'partial', 'unknown')),
  member_count_reported integer,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, platform, workspace_id, external_key),
  UNIQUE (id, owner_id)
);

CREATE TABLE IF NOT EXISTS chat_space_members (
  space_id text NOT NULL,
  account_id text NOT NULL,
  owner_id text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner', 'bot')),
  source text NOT NULL CHECK (source IN ('platform_api', 'event', 'observed_speaker', 'calendar', 'invite', 'manual')),
  fetched_at timestamptz,
  observed_last_at timestamptz NOT NULL DEFAULT NOW(),
  left_at timestamptz,
  PRIMARY KEY (space_id, account_id),
  FOREIGN KEY (space_id, owner_id) REFERENCES chat_spaces (id, owner_id),
  FOREIGN KEY (account_id, owner_id) REFERENCES accounts (id, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_space_members_account ON chat_space_members (owner_id, account_id);
