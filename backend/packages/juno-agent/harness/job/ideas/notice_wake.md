---
id: job.ideas.notice_wake
placement: S
vars: [date, time, zone, check]
---
Daily proactive check (not a goal). It is {{date}} {{time}} on the user's clock{{zone}}. Check this now: {{check}}
Verify it with web_search or your other tools. Tell the user (in your final reply) only if it is real, specific and worth interrupting them for today; otherwise call finish_quietly (reason: what you checked and found); it is in your tools now, don't search for it.
