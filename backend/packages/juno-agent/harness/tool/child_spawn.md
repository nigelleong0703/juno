---
id: tool.child_spawn
placement: T
vars: []
---
Spawn a visible child task: a separate run that works on the prompt in THIS conversation and reports back here. It is bounded by the inherited budget, depth and active-child concurrency; the child cannot message other agents and cannot spawn beyond the depth limit. It runs in the background by default: you may finish this turn (reply to the user, handle other messages) and you are woken with a task_done event carrying its result when it ends — no child_wait needed. Pass notify: false only in the rare case you need the result in this same turn, then use child_wait. tools (optional) narrows the child to those tool names; it can never widen the target agent's tools. fast (optional) runs the child on a quicker, cheaper model that reasons less carefully; you decide whether the task needs that care. deep (optional) makes the child think much longer before answering, so it is slower and costs more; you decide whether the task is worth it. The child shows in the user's task list under title.
