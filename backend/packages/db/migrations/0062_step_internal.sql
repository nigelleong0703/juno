-- 0061: `Step.internal` (contract: plumbing steps). New steps get it when they are written (juno-agent modules/tools/plumbing.ts);
-- this marks the steps that already exist, once, so clients keep no list of tool names for history either. A step before 0.54 has
-- no `tool` and records the tool as its target of an "Executed" step. Safe to repeat: a step that has the field is skipped.
-- The list is the same as PLUMBING_TOOLS in plumbing.ts.

UPDATE steps
SET doc = doc || '{"internal": true}'::jsonb, updated_at = NOW()
WHERE doc->'internal' IS NULL
  AND COALESCE(doc->>'tool', CASE WHEN doc->>'verb' = 'Executed' THEN doc->>'target' END) = ANY (ARRAY[
    'tool_search', 'tool_load', 'tool_call', 'skill_search', 'skill_read', 'skill_load',
    'todo_write', 'task_update', 'task_stop', 'tasks_list', 'state_update', 'goal_update', 'profile_update', 'agent_update', 'connect_request',
    'transcript_read', 'output_read', 'child_wait', 'child_results', 'child_poll',
    'computer.screenshot', 'computer.move', 'browser.snapshot', 'browser.get_text',
    'send_message', 'react']);

-- The copy of each step inside its run.
UPDATE runs r
SET doc = jsonb_set(r.doc, '{steps}', (
      SELECT jsonb_agg(
               CASE WHEN s->'internal' IS NULL
                      AND COALESCE(s->>'tool', CASE WHEN s->>'verb' = 'Executed' THEN s->>'target' END) = ANY (ARRAY[
                        'tool_search', 'tool_load', 'tool_call', 'skill_search', 'skill_read', 'skill_load',
                        'todo_write', 'task_update', 'task_stop', 'tasks_list', 'state_update', 'goal_update', 'profile_update', 'agent_update', 'connect_request',
                        'transcript_read', 'output_read', 'child_wait', 'child_results', 'child_poll',
                        'computer.screenshot', 'computer.move', 'browser.snapshot', 'browser.get_text',
                        'send_message', 'react'])
                    THEN s || '{"internal": true}'::jsonb ELSE s END
               ORDER BY ord)
      FROM jsonb_array_elements(r.doc->'steps') WITH ORDINALITY AS t(s, ord))),
    updated_at = NOW()
WHERE jsonb_typeof(r.doc->'steps') = 'array' AND jsonb_array_length(r.doc->'steps') > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(r.doc->'steps') AS e(s)
    WHERE s->'internal' IS NULL
      AND COALESCE(s->>'tool', CASE WHEN s->>'verb' = 'Executed' THEN s->>'target' END) = ANY (ARRAY[
        'tool_search', 'tool_load', 'tool_call', 'skill_search', 'skill_read', 'skill_load',
        'todo_write', 'task_update', 'task_stop', 'tasks_list', 'state_update', 'goal_update', 'profile_update', 'agent_update', 'connect_request',
        'transcript_read', 'output_read', 'child_wait', 'child_results', 'child_poll',
        'computer.screenshot', 'computer.move', 'browser.snapshot', 'browser.get_text',
        'send_message', 'react']));
