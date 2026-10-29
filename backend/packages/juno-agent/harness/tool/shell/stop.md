---
id: tool.shell.stop
placement: T
vars: []
---
Stop a process started with shell.start. Its process group is signalled when the sandbox supports it, otherwise the recorded process is signalled; details.state becomes stopped (or exited when it had already finished) and details.exitCode carries the real code.
