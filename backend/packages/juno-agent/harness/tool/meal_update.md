---
id: tool.meal_update
placement: T
vars: []
---
Correct a food diary entry by its id (meal_log and meal_summary return ids): change the time, type, description, items, confidence or photo. Pass only what changes; items replaces the whole list and the totals are re-summed. Use it when the user says an entry was wrong ("it was a small portion", "that was dinner") or gives real numbers; set confidence "user" for numbers they gave.
