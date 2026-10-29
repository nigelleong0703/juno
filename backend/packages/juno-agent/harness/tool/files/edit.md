---
id: tool.files.edit
placement: T
vars: []
---
Edit a file on one of your computers (default: the sandbox) by replacing an exact string. The match must be unique unless replaceAll is true. Pass expectedHash (from files.read) or expectedContent to refuse a stale edit when the file changed since you read it; that check is read-then-write on the sandbox, not an atomic compare-and-swap. Relative paths resolve against the working directory.
