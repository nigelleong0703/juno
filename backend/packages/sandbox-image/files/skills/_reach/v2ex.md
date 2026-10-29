---
name: agent-reach
description: Read a V2EX topic with its replies, hot topics or a node. Use for v2ex.com links or when asked what V2EX is discussing.
---
## V2EX

```
agent-reach v2ex hot --limit 10
agent-reach v2ex node <node name> --limit 10        # e.g. python, programmer, jobs
agent-reach v2ex read <topic link or id>
agent-reach v2ex user <username>
```

- `read` returns the topic and its replies in `items[0].text`, one `@member: reply` per reply. The full list of replies is in `raw.replies`. It is the first page the API returned: say so when a long thread may have more.
- A topic that was deleted or hidden is `NOT_FOUND`.
- Posts are in Chinese as written; translate or summarise in the person's language when they ask.
