---
id: hook.blocked_input
placement: W
vars: [blocked]
---
[internal waiting tasks] These tasks are blocked waiting for input: {{blocked}}. A new message just arrived: if it answers what a blocked task waited for, set that task back to in_progress with todo_write and carry on (for a background child task that asked, pass the answer on with child_message); if it does not, answer the message and leave the task blocked.
