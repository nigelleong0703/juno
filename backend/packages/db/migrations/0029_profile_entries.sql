-- 0029: the account profile (BACKEND 8.7) stops being fixed fields (fullName/firstName/lastName, emails, phones, addresses, custom)
-- and becomes one flat list `entries` of { id, key, value, visibility, source }. Existing documents are converted once: the name
-- becomes "Name", each email its label or "Email", each phone "Phone" (+ label), each address "Address" (+ label) with a multi-line
-- value, custom entries as they are. Same-named keys get " 2", " 3" so each key stays unique. Origin is unknown, so source is the user at the doc's updatedAt.
WITH src AS (
  SELECT id, doc, coalesce(doc->>'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS at
  FROM profiles WHERE NOT doc ? 'entries'
),
parts AS (
  SELECT id, 0 AS grp, 0::bigint AS ord, 'Name' AS key,
         coalesce(nullif(doc->>'fullName', ''), nullif(btrim(concat_ws(' ', doc->>'firstName', doc->>'lastName')), '')) AS value,
         coalesce(doc->>'nameVisibility', 'private') AS vis, at
  FROM src
  UNION ALL
  SELECT s.id, 1, e.ord, coalesce(e.v->>'label', 'Email'), e.v->>'value', coalesce(e.v->>'visibility', 'private'), s.at
  FROM src s, jsonb_array_elements(coalesce(s.doc->'emails', '[]'::jsonb)) WITH ORDINALITY AS e(v, ord)
  UNION ALL
  SELECT s.id, 2, e.ord, 'Phone' || coalesce(' (' || (e.v->>'label') || ')', ''), e.v->>'value', coalesce(e.v->>'visibility', 'private'), s.at
  FROM src s, jsonb_array_elements(coalesce(s.doc->'phones', '[]'::jsonb)) WITH ORDINALITY AS e(v, ord)
  UNION ALL
  SELECT s.id, 3, e.ord, 'Address' || coalesce(' (' || (e.v->>'label') || ')', ''),
         concat_ws(E'\n', e.v->>'recipient', e.v->>'line1', e.v->>'line2', e.v->>'unit',
                   nullif(btrim(concat_ws(' ', e.v->>'city', e.v->>'postalCode')), ''), e.v->>'country',
                   CASE WHEN e.v->>'phone' IS NULL THEN NULL ELSE 'Phone: ' || (e.v->>'phone') END),
         coalesce(e.v->>'visibility', 'private'), s.at
  FROM src s, jsonb_array_elements(coalesce(s.doc->'addresses', '[]'::jsonb)) WITH ORDINALITY AS e(v, ord)
  UNION ALL
  SELECT s.id, 4, e.ord, e.v->>'key', e.v->>'value', coalesce(e.v->>'visibility', 'private'), s.at
  FROM src s, jsonb_array_elements(coalesce(s.doc->'custom', '[]'::jsonb)) WITH ORDINALITY AS e(v, ord)
),
keyed AS (
  SELECT *, row_number() OVER (PARTITION BY id, lower(key) ORDER BY grp, ord) AS rn
  FROM parts WHERE value IS NOT NULL AND value <> '' AND key IS NOT NULL AND key <> ''
),
built AS (
  SELECT id, jsonb_agg(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'key', left(CASE WHEN rn > 1 THEN key || ' ' || rn ELSE key END, 60),
    'value', left(value, 2000),
    'visibility', vis,
    'source', jsonb_build_object('by', 'user', 'at', at)
  ) ORDER BY grp, ord) AS entries
  FROM keyed GROUP BY id
)
UPDATE profiles p
SET doc = (p.doc - ARRAY['fullName', 'firstName', 'lastName', 'nameVisibility', 'emails', 'phones', 'addresses', 'custom'])
          || jsonb_build_object('entries', coalesce((SELECT b.entries FROM built b WHERE b.id = p.id), '[]'::jsonb))
WHERE NOT p.doc ? 'entries';
