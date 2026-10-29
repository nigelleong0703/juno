---
id: tool.shell.poll
placement: T
vars: []
---
Read new output from a process started with shell.start. Pass back the cursor from the previous poll to get only what is new; stdout is returned separately from stderr (with its own stderrCursor) so diagnostics never mix into a program's own protocol output. Output is bounded (details.truncated says more remains); details.state is running/exited/stopped/expired and details.exitCode is the real exit code once it exited.
