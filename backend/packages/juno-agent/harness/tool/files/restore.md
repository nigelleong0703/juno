---
id: tool.files.restore
placement: T
vars: []
---
Put back an earlier version of a text file that files.write or files.edit replaced; use it when the user asks you to undo a change to a file. Without snapshotId it restores the newest kept version of that path. The version it replaces is kept too, so a restore can be undone the same way. Only files.write and files.edit keep earlier versions (the last 20 per file, for 14 days); a change made by a shell command cannot be restored.
