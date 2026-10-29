---
id: tool.request_withdraw
placement: T
vars: []
---
Withdraw a request of yours that is still open (an approval, sign-in, take-over or secure-input card) because the user changed their plan, so the card closes. Use it after the system note says the user messaged you instead of deciding. Pass reason: the user own words about why (the card then shows Withdrawn in chat: <reason>). Without requestId it withdraws your own open request in this run. It never approves or denies anything.
