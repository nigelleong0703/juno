---
id: tool.transcript_search
placement: T
vars: []
---
Search the whole chat history of the current conversation for messages containing ALL the words of the query (case-insensitive), newest first. Use it when the user refers to something from earlier that is not in your current context. Words match as substrings, so pass 1–3 short keywords (for Chinese, short terms like 显示器 rather than a sentence). Optional after/before (ISO date or datetime) bound the time; limit defaults to 10, max 20. Each hit shows its time, author and a snippet; then call transcript_read with around = the hit time to read the full exchange.
