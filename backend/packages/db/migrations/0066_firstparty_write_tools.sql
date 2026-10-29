-- 0066: the first-party Google and Microsoft connectors gained write tools, and Stripe's write tools are now classified (BACKEND 10.18.2).
-- The catalog seed never overwrites a row that exists, so the rows seeded earlier get the new capability tags and listing text here, once.
-- A row is changed only while it still holds the value earlier code seeded, so an admin's edit is left alone; safe to repeat.

UPDATE app_catalog AS c
SET doc = jsonb_set(c.doc, '{provides}', to_jsonb(t.new_tags), true), updated_at = NOW()
FROM (VALUES
  ('gmail', ARRAY['mail.read', 'mail.draft'], ARRAY['mail.read', 'mail.draft', 'mail.send']),
  ('google-calendar', ARRAY['calendar.read'], ARRAY['calendar.read', 'calendar.write']),
  ('google-drive', ARRAY['files.read'], ARRAY['files.read', 'files.write']),
  ('onedrive', ARRAY['files.read', 'docs.read'], ARRAY['files.read', 'files.write', 'docs.read']),
  ('microsoft-contacts', ARRAY['contacts.read'], ARRAY['contacts.read', 'contacts.write']),
  ('stripe', ARRAY['payments.read'], ARRAY['payments.read', 'payments.write'])
) AS t(app_id, old_tags, new_tags)
WHERE c.doc->>'appId' = t.app_id
  AND c.doc->'provides' = to_jsonb(t.old_tags);

UPDATE app_catalog AS c
SET doc = jsonb_set(jsonb_set(c.doc, '{interface,longDescription}', to_jsonb(t.new_text), true), '{interface,shortDescription}', to_jsonb(t.new_text), true), updated_at = NOW()
FROM (VALUES
  ('gmail', 'Search and read your email, and write drafts.', 'Search and read your email, write drafts, send mail and label messages.'),
  ('google-calendar', 'See your calendars, events and free time.', 'See your calendars, events and free time, and add, change or answer events.'),
  ('google-drive', 'Find and read files in your Drive.', 'Find and read files in your Drive, and create or copy them.'),
  ('outlook-mail', 'Search and read your Outlook email, write drafts and send them.', 'Search and read your Outlook email, write drafts, reply, forward and send.'),
  ('outlook-calendar', 'See your Outlook calendars, events and free time, and add or change events.', 'See your Outlook calendars, events and free time, and add, change, delete or answer events.'),
  ('microsoft-todo', 'See, add and complete your To Do tasks.', 'See, add, change, complete and delete your To Do tasks.'),
  ('onedrive', 'Find and read your OneDrive files, including Word, Excel and PowerPoint.', 'Find, read and save your OneDrive files, including Word, Excel and PowerPoint.'),
  ('microsoft-contacts', 'Look up people in your Outlook contacts.', 'Look up people in your Outlook contacts, and add new ones.'),
  ('stripe', 'Look up customers, payments and invoices.', 'Look up customers, payments and invoices, and make changes in your Stripe account.')
) AS t(app_id, old_text, new_text)
WHERE c.doc->>'appId' = t.app_id
  AND c.doc->'interface'->>'longDescription' = t.old_text;

UPDATE app_catalog
SET doc = jsonb_set(doc, '{tools}', '{"stripe_api_write":"change","send_money":"change","transfer_money":"change","convert_currency":"change","setup_recipient":"change","atlas_company_formation":"change"}'::jsonb, true), updated_at = NOW()
WHERE doc->>'appId' = 'stripe' AND doc->'tools' IS NULL;
