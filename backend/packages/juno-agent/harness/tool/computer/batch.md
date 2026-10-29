---
id: tool.computer.batch
placement: T
vars: []
---
Run up to 12 browser or screen actions in order in one call, then see the page once. Use it when you can already predict two or more actions: filling in a form, clicking through a known flow. Do not batch when the next action depends on what the previous one shows (a page that loads, a menu that opens, search results): act, look, then act. Each step is {tool, args}: the arguments that tool takes on its own, with refs from your latest snapshot. Steps run in order and stop at the first one that fails, and the result says which and why. A step that needs the user's approval (an order, a payment, anything you would mark confirm) is not run: the batch stops before it, so call that action on its own. You get one observation at the end, the changes since the last snapshot you saw (observe none returns only a line per step): check it to confirm the batch did what you meant.
