---
id: tool.tool_load
placement: T
vars: []
---
Get the complete parameters of tools you already know by exact name (for example from the discovery directory or an earlier search), then run them with tool_call(name, arguments). names is required: 1 to 10 exact canonical tool names. Unknown names are reported, never guessed; to find a tool by what it does, use tool_search instead.
