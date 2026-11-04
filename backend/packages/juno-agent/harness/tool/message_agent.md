---
id: tool.message_agent
placement: T
vars: []
---
Send a message to another agent. It is posted in the current room as a chat line that starts with their name (do not type the name; write one or two short sentences) and wakes the target there; it ends your turn, so nothing more is posted after it; it only works inside a room the user is in (agents never talk privately), so from a direct chat create a room with conversation_create and then use send_message with that room's conversationId and targetAgentIds, or give the work to a subagent with subagent_start. memoryRefs (optional) are ids of memory items (mem_…) the target needs: only those you both may hear reach it, with who said them and where; the rest are left out and you are told how many.
