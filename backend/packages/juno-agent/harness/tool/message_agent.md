---
id: tool.message_agent
placement: T
vars: []
---
Send a message to another agent. It is posted in the current room and wakes the target there; it only works inside a room the user is in (agents never talk privately), so from a direct chat create a room with conversation_create and then use send_message with that room's conversationId and targetAgentIds, or give the work to a sub-task with child_spawn. memoryRefs (optional) are ids of memory items (mem_…) the target needs: only those you both may hear reach it, with who said them and where; the rest are left out and you are told how many.
