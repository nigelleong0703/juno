---
id: tool.task_stop
placement: T
vars: []
---
Stop one of your background tasks by its id (from tasks_list): a shell process is stopped, a wait_for notify wait is dropped, a background child is cancelled as child_cancel does. A background MCP call is cancelled while it runs (the server is told; it may still finish) and its result is dropped.
