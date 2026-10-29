-- 0028: an agent has its sandbox always and may also use the owner's Mac (macAccess), instead of choosing one computer
-- (computerId 'default' | 'mac'). An agent that was set to the Mac keeps using it: macAccess true. The old key is removed.
UPDATE agents
SET doc = (doc - 'computerId') || jsonb_build_object('macAccess', coalesce(doc->>'computerId' = 'mac', false))
WHERE doc ? 'computerId' OR NOT doc ? 'macAccess';
