---
id: tool.state_update
placement: T
vars: []
---
Save state. target "routine" + action "create": schedule `prompt` as routine `name` on cron `schedule` (in the user local time), delivered to this chat. When the user wants the result on their Feed (a daily brief, news, a watch), say so in `prompt` ("post it to my Feed only when there is something new"); each run starts from `prompt` alone. `requires` declares what the task needs to do its work, as a list; always give it when the task reads an app or uses a tool. Each item is a capability with the options that provide it (any one is enough): {"calendar": ["google-calendar", "mac"]}, {"mail": ["gmail", "outlook", "mac"]}, "web_search" (news or anything from the web), "computer" (a browser task), "mac" (Mail, Calendar and Reminders on the owner's Mac, as an option of mail / calendar / reminders), or one connector id such as "notion", "linear", "google-drive". If the user has not connected what it needs, the routine is saved as needs_setup (it will not run), a Connect card is added to this chat, and the result tells you what is missing: tell the user plainly what to connect. When they connect it you are told and the routine starts.
