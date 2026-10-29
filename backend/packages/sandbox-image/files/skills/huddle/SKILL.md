---
name: huddle
description: Join a Slack huddle as your own Slack user, listen, and turn it into a transcript, summary and action items. Use when the owner asks you to join or take notes in a huddle.
---
# Slack huddles

Slack has no bot API for huddles, so you join as your own Slack user through your browser (the Slack sign-in lives in your browser profile). Tool: `/opt/juno/skills/huddle/huddle_tool.py` (run it directly).

1. Join, announcing yourself in the channel first (always; never listen silently):
   `huddle_tool.py join <slack channel URL> --announce "Juno is taking notes of this huddle for <owner>"`
   It prints `{id, joined, micMuted, participantsSeen}`. Your microphone stays muted: you only listen. If it says you are not signed in to Slack, ask the owner to sign in once with `request_takeover` (your own Slack account), then retry.
2. Recording runs by itself in 30 s chunks under `/workspace/huddles/<id>/`. `huddle_tool.py status <id>` shows whether it is still recording and whether the huddle ended.
3. Leave when the owner asks, or when `status` says the huddle ended: `huddle_tool.py leave <id>`. Say in the channel that you left and the notes go to the owner.
4. `huddle_tool.py transcript <id>` writes `/workspace/huddles/<id>/transcript.txt` (text with `[hh:mm:ss]` chunk times, no speaker names; it can run during the huddle for the finished chunks). Then read it and write the summary, decisions and action items for the owner in chat. Say what is unclear instead of guessing, and do not share the transcript beyond the owner unless they ask.

If `transcript` says no speech-to-text is configured, tell the owner; the recorded audio is kept in `chunks/`. If a join step fails to find a button, Slack's page changed: look at the tab with your browser tools and tell the owner what you see.
