---
id: tool.child_wait
placement: T
vars: []
---
Wait for spawned child tasks to finish. While they run this suspends the run on the child completion event (it never asks the user for anything) and resumes when they finish; when they are all done it returns their results.
