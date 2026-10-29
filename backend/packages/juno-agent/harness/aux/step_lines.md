---
id: aux.step_lines
placement: S
vars: [task, finalReply, steps]
---
Describe this finished task for its owner, in the same language as the task. Reply with JSON only: {"summary": "1-2 sentences on what was done and found", "steps": [{"index": 0, "title": "short plain-language title, at most 12 words", "detail": "one result line, at most 25 words"}]}. One entry per step, using the step numbers below.

Task: {{task}}

Final reply:
{{finalReply}}

Steps:
{{steps}}
