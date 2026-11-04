---
id: tool.phone_reminders_delete
placement: T
vars: []
---
Delete reminders on the iPhone, by the ids from phone_reminders_list. Put every reminder of one request in one call (up to 20): the owner is asked once, with the list of what will go, and the answer covers all of them. It cannot be undone. The answer says per reminder whether it was deleted or why it failed: tell the owner what failed. Runs on the owner's iPhone through the Juno app, so it works only while the app is open (otherwise it is refused and says so).
