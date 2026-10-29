---
id: tool.child_message
placement: T
vars: []
---
Send a follow-up message to one child task this run spawned. A running child reads it at its next step. A finished child is continued as a new run that keeps its earlier conversation; wait for the new run with child_wait. Use child_results to read what it reported.
