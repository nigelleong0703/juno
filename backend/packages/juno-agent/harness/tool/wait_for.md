---
id: tool.wait_for
placement: T
vars: []
---
Wait for an external event (webhook/connector) matching a filter. By default this run pauses until it arrives. With notify: true the run keeps going (you may finish this turn) and you are woken once with a task_done carrying the event when it arrives.
