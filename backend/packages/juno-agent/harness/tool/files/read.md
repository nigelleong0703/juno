---
id: tool.files.read
placement: T
vars: []
---
Read a file from one of your computers (default: the sandbox); relative paths resolve against that computer's working directory. The text RETURNED to you is bounded: to page a large file pass startLine/maxLines (and lineOffset to resume inside one very long line). details gives the hash, the last fully delivered line (endLine) and the exact continuation (nextStartLine/nextLineOffset) so paging never skips or repeats content.
