---
id: tool.output_read
placement: T
vars: []
---
Read a bounded page of a large tool result that was retained as an artifact (a bounded result carries an output_read hint with its ref). Pages are lossless: pass back the returned nextCursor to continue. Only artifacts produced for this agent are readable.
