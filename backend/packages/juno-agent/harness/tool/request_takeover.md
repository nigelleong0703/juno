---
id: tool.request_takeover
placement: T
vars: []
---
Ask the user to take over your screen for one step you cannot do yourself (a captcha, a sign-in, an unusual verification check). Pass the ref of the element you are stuck on from the latest browser snapshot so their device zooms to it. Use it only when you cannot proceed; for passwords, card details or codes use request_secure_input instead. This tool is the ONLY way to hand the screen to the user: the card it raises (with a Take over button) and the notification are the only place they can act, so never write "take over the screen" or "tap it yourself" in chat without calling it, and try the step yourself first (seat maps, date pickers and menus are ordinary page elements you can click). The reason is shown on the card as the whole instruction: say plainly what to do on the screen and when to hand back. The run waits until they hand control back or decline; then take a fresh snapshot and continue.
