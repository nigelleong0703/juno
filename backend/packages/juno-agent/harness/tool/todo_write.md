---
id: tool.todo_write
placement: T
vars: []
---
Update the task plan for this agent and conversation. Todos are high-level goals (what, not how), not steps or tool calls; skip the plan for short tasks, and change it only when a goal finishes, changes or is blocked. Default merge keeps unmentioned todos, updates mentioned ones in place by id, and appends new ones; pass merge:false to replace the whole plan. A child run writes only its own child scope, created on first write; it never touches the root plan. Returns the stable todo ids so later calls can update the same entries. A todo with status blocked requires a non-empty note naming the missing input or dependency.
