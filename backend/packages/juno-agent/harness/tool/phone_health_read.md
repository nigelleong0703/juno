---
id: tool.phone_health_read
placement: T
vars: []
---
Read the owner's Health data from the iPhone for one metric over a date range, as totals and averages (steps and active energy per day, workouts with their length and calories, sleep per night, body weight first to last), never raw samples. Read only: nothing can be written to Health. This is private health information: use it only to answer what the user asked, do not repeat it to anyone else or put it anywhere else. "No data" can also mean the owner did not allow that kind of data in the Health app (the app cannot tell); say so instead of guessing. Runs on the owner's iPhone through the Juno app, so it works only while the app is open and the phone is unlocked (otherwise it is refused and says so).
