/**
 * Which tools are plumbing (public `Step.internal`): finding a tool or skill, the agent's own bookkeeping, reading back an observation,
 * and the steps that repeat a message the person already sees. Their steps are recorded but a client leaves them out of the activity
 * list, so the three clients no longer keep their own lists of tool names. One list, here.
 */
export const PLUMBING_TOOLS: ReadonlySet<string> = new Set([
  // Finding things.
  'tool_search', 'tool_load', 'tool_call', 'skill_search', 'skill_read', 'skill_load',
  // The agent's own bookkeeping.
  'todo_write', 'task_update', 'task_stop', 'tasks_list', 'state_update', 'goal_update', 'profile_update', 'agent_update', 'connect_request',
  // Reading back what it already did or saw.
  'transcript_read', 'output_read', 'child_wait', 'child_results', 'child_poll',
  'computer.screenshot', 'computer.move', 'browser.snapshot', 'browser.get_text',
  // The message or reaction is itself on screen.
  'send_message', 'react',
]);

export const isPlumbingTool = (name: string): boolean => PLUMBING_TOOLS.has(name);
