---
id: tool.subagent_start
placement: T
vars: []
---
Start a subagent: a separate run that works on the prompt in THIS conversation and reports back here. It is bounded by the inherited budget, depth and active-subagent concurrency; it cannot message other agents and cannot start another beyond the depth limit. It always runs in the background and you never wait for it: end your turn when nothing else is left to do, and you are woken with a task_done event carrying its result when it ends (a long result comes as an artifact you read with output_read). tasks_list shows its status, and task_stop stops it. fast (optional) runs it on a quicker, cheaper model that reasons less carefully; deep (optional) makes it think much longer, slower and costlier; you decide whether the task is worth either. The subagent shows in the user's task list under title.
