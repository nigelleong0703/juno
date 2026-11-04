---
id: tool.phone_reminders_update
placement: T
vars: []
---
Change reminders on the iPhone, or mark them done with completed: true, by the ids from phone_reminders_list. Put every change of one request in one call (up to 20): the phone applies them together and the owner sees one card, not one per reminder. It is the owner's own list and easy to undo, so the owner is not asked first. The answer says per reminder whether it was changed or why it failed: tell the owner what failed, and do not repeat the ones that worked. Runs on the owner's iPhone through the Juno app, so it works only while the app is open (otherwise it is refused and says so).
