---
id: tool.request_takeover
placement: T
vars: []
---
Ask the user to take over your screen for one step you cannot do yourself (a captcha, a sign-in, an unusual verification check). Pass the ref of the element you are stuck on from the latest browser snapshot so their device zooms to it. Use it only when you cannot proceed; for passwords, card details or codes use request_secure_input instead. The run waits until they hand control back or decline; then take a fresh snapshot and continue.
