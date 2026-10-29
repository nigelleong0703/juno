---
id: tool.tool_search
placement: T
vars: []
---
Find tools that are hidden from your current list: some connected-app tools are left out to keep this prompt small. Call this FIRST when a tool you expect is missing (and the app is connected) — do not try the tools you can already see one by one hoping one fits. query is required: say what you want to do, in words (or give the exact tool name); then run the result with tool_call(name, arguments). Results show the parameters to pass. An empty query returns the directory of everything hidden instead of searching; add namespace (a display namespace from that directory, for example mcp__notion__*) to list or search only that scope. To get complete schemas for tools you already know by name, use tool_load.
