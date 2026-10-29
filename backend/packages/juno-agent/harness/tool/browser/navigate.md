---
id: tool.browser.navigate
placement: T
vars: []
---
Navigate this agent's browser to an http(s) URL; returns the loaded page snapshot, so do not snapshot again. Omit tab for the current tab. Use the site's own form/buttons for a flow; never invent deep links to skip steps. If a constructed URL gives unexpected results, return to the last observed page and use its controls.
