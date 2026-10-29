---
id: tool.computer.act
placement: T
vars: []
---
Click, type, press keys or scroll in an app on the user's Mac, in the background, in one call: steps run in order, stop at the first failure and the result says what changed. Steps are {tool, args} with tool click, double_click, right_click, set_value, type_text, press_key, hotkey, scroll or drag; target by element_token from the latest snapshot, by role and name, or by x,y pixels of a screenshot. If the app only takes input in front, the result says so: retry with foreground true, which asks the user first. Before a step that places an order, pays or otherwise commits money, pass approval or confirm.
