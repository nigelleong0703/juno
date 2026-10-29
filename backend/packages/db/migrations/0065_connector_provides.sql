-- 0060: capability tags on the built-in connectors (BACKEND 10.18.1). `provides` says what an app lets an agent do ("mail.send"), so a need
-- ("send email") finds the apps of our catalog that could meet it. The seed only adds apps the table lacks, so the rows seeded earlier get
-- their tags here, once, from what each app's tools really do (Gmail writes drafts but cannot send; Outlook Mail can). Every version of an app
-- is updated; a row that already has tags (an admin set them) is left alone, so this is safe to repeat.

UPDATE app_catalog AS c
SET doc = jsonb_set(c.doc, '{provides}', to_jsonb(t.tags), true), updated_at = NOW()
FROM (VALUES
  ('gmail', ARRAY['mail.read', 'mail.draft']),
  ('google-calendar', ARRAY['calendar.read']),
  ('google-drive', ARRAY['files.read']),
  ('google-docs', ARRAY['docs.read', 'docs.write']),
  ('google-sheets', ARRAY['sheets.read', 'sheets.write']),
  ('google-contacts', ARRAY['contacts.read']),
  ('google-maps', ARRAY['maps.read']),
  ('google-tasks', ARRAY['tasks.read', 'tasks.write']),
  ('youtube', ARRAY['video.search']),
  ('sg-transport', ARRAY['transport.read']),
  ('youtube-account', ARRAY['video.library']),
  ('outlook-mail', ARRAY['mail.read', 'mail.draft', 'mail.send']),
  ('outlook-calendar', ARRAY['calendar.read', 'calendar.write']),
  ('microsoft-todo', ARRAY['tasks.read', 'tasks.write']),
  ('onedrive', ARRAY['files.read', 'docs.read']),
  ('microsoft-contacts', ARRAY['contacts.read']),
  ('teams', ARRAY['chat.read']),
  ('notion', ARRAY['notes.read', 'notes.write']),
  ('linear', ARRAY['projects.read', 'projects.write']),
  ('asana', ARRAY['tasks.read', 'tasks.write', 'projects.read', 'projects.write']),
  ('atlassian', ARRAY['projects.read', 'projects.write', 'docs.read', 'docs.write']),
  ('stripe', ARRAY['payments.read']),
  ('strava', ARRAY['fitness.read']),
  ('hevy', ARRAY['fitness.read', 'fitness.write']),
  ('zapier', ARRAY['automation.run'])
) AS t(app_id, tags)
WHERE c.doc->>'appId' = t.app_id
  AND c.doc->'provides' IS NULL;
