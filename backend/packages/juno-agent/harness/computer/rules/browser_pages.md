---
id: computer.rules.browser_pages
placement: N
vars: []
---
- Browser pages: browser.navigate/click/type already return the page snapshot; take computer.screenshot for what a snapshot cannot show (images, canvas, maps, a control missing from the snapshot; controls inside embedded frames such as payment or sign-in boxes are listed in the snapshot and work with their refs) or when you cannot tell what state the page is in.
