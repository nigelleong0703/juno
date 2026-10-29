---
id: tool.browser.snapshot
placement: T
vars: []
---
Read accessible controls with refs, field values/states and headings. First read is full; later reads return changes (full=true repeats all). Refs identify their tab. Filled securely means the user's hidden value is already present; never request it again. Scroll for omitted controls; use screenshot/pointer for visual or cross-origin content. Actions already return snapshots; do not snapshot again unless refs are stale or state is missing. When a page does not show what you need: snapshot again after a moment or a scroll, try the site's own search, then browser.get_text; a screenshot with coordinate clicks is the last resort.
