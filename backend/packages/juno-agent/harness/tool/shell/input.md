---
id: tool.shell.input
placement: T
vars: []
---
Send text to a running process's stdin on this agent's bound computer. Use it for a command that waits for input (a prompt, a REPL, a confirmation). Include a trailing newline when the program expects a line. It fails clearly when the process has no writable stdin or has already exited.
