---
id: tool.shell.start
placement: T
vars: []
---
Start a command on one of your computers (default: the sandbox) as an asynchronous process and return a handle. It keeps running between calls: read its output with shell.poll, send bytes to its stdin with shell.input, and end it with shell.stop (they find the computer it runs on by the handle). It runs detached in the working directory; there is no interactive terminal. With notifyOnExit: true you may finish this turn and are woken with a task_done (exit code and the start of its output) when the process ends — no polling needed.
