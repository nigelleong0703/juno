-- 0050: topics for memory items and a short summary per topic (BACKEND §5.4 "Nightly tidy", §9.5). The digest and memory_note give a new
-- item its topic when they write it; the nightly tidy gives one to every item that has none (NULL = not assigned yet, read as 'other').
-- memory_topic_summaries holds the 1-3 sentence summary the nightly job writes per topic and owner, in the second person, for the owner's
-- own Memory page. It is built only from owner and public items (never a group's), and is owner-scoped like every table.

ALTER TABLE memory_items
  ADD COLUMN topic text NULL CHECK (topic IN ('identity', 'health', 'work', 'plans', 'preferences', 'people', 'agents', 'home', 'other'));
CREATE INDEX idx_memory_items_owner_topic ON memory_items (owner_id, topic, status);

CREATE TABLE memory_topic_summaries (
  owner_id text NOT NULL,
  topic text NOT NULL CHECK (topic IN ('identity', 'health', 'work', 'plans', 'preferences', 'people', 'agents', 'home', 'other')),
  summary text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, topic)
);
